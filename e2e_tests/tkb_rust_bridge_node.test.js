"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const BRIDGE_PATH = path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js");
const BRIDGE_SOURCE = fs.readFileSync(BRIDGE_PATH, "utf8");
const PLANNER_SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "web", "pages", "phanmon.js"), "utf8");
const PLANNER_HTML = fs.readFileSync(path.resolve(__dirname, "..", "web", "pages", "sapxep.html"), "utf8");

function memoryStorage(){
  const values = new Map();
  return {
    getItem(key){ return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value){ values.set(String(key), String(value)); },
    removeItem(key){ values.delete(String(key)); },
    clear(){ values.clear(); }
  };
}

function makeData(expectedPeriods, options = {}){
  const fixedOff = options.fixedOff === true;
  return {
    lop: [{id:"L1", ten:"10A1", ten2:"10A1", khoi:"10"}],
    mon: [{ten:"Toán", khoi:"10", sotiet:expectedPeriods}],
    monhoc: [{ten:"Toán", ma:"TOAN"}],
    giaovien: [{ma:"GV01", ten:"Giáo viên 01"}],
    pccmMatrix: {"L1|Toán":"GV01"},
    pccmTietMatrix: {"L1|Toán":expectedPeriods},
    pccmRoomMatrix: {},
    pccmGioihanMatrix: {},
    tkb: {},
    tkbUserOff: {},
    tkbConstraints: fixedOff
      ? {fixedOff:{class:{L1:{"thu2|sang|0":true}}}}
      : {}
  };
}

function makeLargeApplyFixture(classCount = 40, lessonsPerClass = 29){
  const data = makeData(lessonsPerClass);
  const subject = String(data.mon[0].ten);
  const classes = [];
  const lessons = [];
  data.lop = [];
  data.giaovien = [];
  data.pccmMatrix = {};
  data.pccmTietMatrix = {};
  data.tkb = {};

  for(let classIndex = 0; classIndex < classCount; classIndex += 1){
    const classId = `L${classIndex + 1}`;
    const className = `10A${classIndex + 1}`;
    const teacher = `GV${String(classIndex + 1).padStart(2, "0")}`;
    classes.push({id:classId, name:className});
    data.lop.push({id:classId, ten:className, ten2:className, khoi:"10"});
    data.giaovien.push({ma:teacher, ten:teacher});
    data.pccmMatrix[`${classId}|${subject}`] = teacher;
    data.pccmTietMatrix[`${classId}|${subject}`] = lessonsPerClass;

    for(let lessonIndex = 0; lessonIndex < lessonsPerClass; lessonIndex += 1){
      lessons.push({
        classId,
        className,
        subject,
        teacher,
        room:`R${classIndex + 1}`,
        day:2 + Math.floor(lessonIndex / 10),
        session:lessonIndex % 10 < 5 ? "AM" : "PM",
        period:(lessonIndex % 5) + 1
      });
    }
  }

  return {
    data,
    payload:{
      ok:true,
      classes,
      lessons,
      metrics:{
        scheduled_periods:lessons.length,
        expected_periods:lessons.length,
        unassigned_periods:0,
        hard_ok:true,
        core_hard_ok:true
      },
      validation:{hard_ok:true, violations:[]},
      solver:{runtime_settings:{}},
      unassignedLessons:[],
      warnings:[]
    }
  };
}

function createFakeClock(startMs = 1_700_000_000_000, autoAdvanceMaxDelay = 1000){
  let nowMs = startMs;
  let nextTimerId = 1;
  const timers = new Map();

  class FakeDate extends Date {
    constructor(...args){
      super(...(args.length ? args : [nowMs]));
    }
    static now(){ return nowMs; }
  }

  function runDueTimers(){
    while(true){
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if(due.length === 0) return;
      const [id, timer] = due[0];
      if(timer.intervalMs > 0) timer.at += timer.intervalMs;
      else timers.delete(id);
      timer.callback();
    }
  }

  function advance(ms){
    nowMs += Math.max(0, Number(ms) || 0);
    runDueTimers();
  }

  function elapseWithoutTasks(ms){
    nowMs += Math.max(0, Number(ms) || 0);
  }

  function setTimeoutFake(callback, delay = 0){
    const id = nextTimerId++;
    const waitMs = Math.max(0, Number(delay) || 0);
    timers.set(id, {at: nowMs + waitMs, callback});
    if(waitMs <= autoAdvanceMaxDelay){
      Promise.resolve().then(() => {
        if(timers.has(id)) advance(waitMs);
      });
    }
    return id;
  }

  function setIntervalFake(callback, delay = 0){
    const id = nextTimerId++;
    const intervalMs = Math.max(1, Number(delay) || 0);
    timers.set(id, {at: nowMs + intervalMs, callback, intervalMs});
    return id;
  }

  return {
    Date: FakeDate,
    setTimeout: setTimeoutFake,
    clearTimeout(id){ timers.delete(id); },
    setInterval: setIntervalFake,
    clearInterval(id){ timers.delete(id); },
    advance,
    elapseWithoutTasks,
    flushDueTimers:runDueTimers,
    now(){ return nowMs; },
    pendingTimers(){ return timers.size; }
  };
}

function withoutAutomaticBackendResume(clock){
  // The bridge now schedules reconnect only when this browser already has a
  // durable pending id, so a fresh test page no longer needs to swallow the
  // first generic 800 ms timer (which could also be a real network retry).
  return clock;
}

function createProgressDocument(clock){
  const nodes = new Map();
  const events = [];
  const now = () => typeof clock?.now === "function" ? clock.now() : Date.now();

  function makeClassList(initial = []){
    const values = new Set(initial);
    return {
      add(...names){ names.forEach(name => values.add(String(name))); },
      remove(...names){ names.forEach(name => values.delete(String(name))); },
      toggle(name, force){
        const key = String(name);
        const enabled = force == null ? !values.has(key) : !!force;
        if(enabled) values.add(key);
        else values.delete(key);
        return enabled;
      },
      contains(name){ return values.has(String(name)); }
    };
  }

  function makeNode(id, options = {}){
    let hidden = !!options.hidden;
    let textContent = String(options.textContent || "");
    const attributes = new Map();
    const style = {
      setProperty(name, value){ this[String(name)] = String(value); }
    };
    const node = {
      id: String(id || ""),
      dataset: {},
      style,
      classList: makeClassList(options.classes || []),
      disabled: !!options.disabled,
      title: "",
      className: "",
      children: [],
      appendChild(child){ this.children.push(child); return child; },
      remove(){ if(this.id) nodes.delete(this.id); },
      addEventListener(){},
      removeEventListener(){},
      setAttribute(name, value){
        attributes.set(String(name), String(value));
        events.push({type:"attribute", id:this.id, name:String(name), value:String(value), at:now()});
      },
      getAttribute(name){ return attributes.get(String(name)) ?? null; },
      querySelector(){ return null; },
      querySelectorAll(){ return []; }
    };
    Object.defineProperty(node, "hidden", {
      get(){ return hidden; },
      set(value){
        hidden = !!value;
        events.push({type:"hidden", id:node.id, value:hidden, at:now()});
      }
    });
    Object.defineProperty(node, "textContent", {
      get(){ return textContent; },
      set(value){
        textContent = String(value == null ? "" : value);
        events.push({type:"text", id:node.id, value:textContent, at:now()});
      }
    });
    if(node.id) nodes.set(node.id, node);
    return node;
  }

  const button = makeNode("btnAutoSort", {textContent:"Sáº¯p xáº¿p"});
  const wrap = makeNode("autoSortProgress", {hidden:true});
  const fill = makeNode("autoSortProgressFill");
  const pct = makeNode("autoSortProgressPct", {textContent:"0%"});
  const track = makeNode("autoSortProgressTrack");
  const label = makeNode("autoSortProgressLabel");
  const home = makeNode("btnHome");
  const duration = makeNode("solveDurationSeconds");
  duration.value = "";
  makeNode("statusMsg");
  wrap.querySelector = selector => {
    if(selector === ".auto-sort-track") return track;
    if(selector === ".auto-sort-label") return label;
    return null;
  };

  const document = {
    getElementById(id){ return nodes.get(String(id)) || null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(tag){ return makeNode(""); },
    documentElement: {
      appendChild(child){ if(child?.id) nodes.set(String(child.id), child); return child; }
    },
    body: {
      appendChild(child){ if(child?.id) nodes.set(String(child.id), child); return child; }
    }
  };
  return {document, nodes, events, button, wrap, fill, pct, track, label, home, duration};
}

function loadBridge(data, fetchImpl, runtime = {}){
  const localStorage = runtime.localStorage || memoryStorage();
  const sessionStorage = runtime.sessionStorage || memoryStorage();
  const consoleImpl = runtime.console || console;
  const setTimeoutImpl = runtime.setTimeout || setTimeout;
  const clearTimeoutImpl = runtime.clearTimeout || clearTimeout;
  const setIntervalImpl = runtime.enableIntervals === true && typeof runtime.setInterval === "function"
    ? runtime.setInterval
    : (() => 0);
  const clearIntervalImpl = runtime.enableIntervals === true && typeof runtime.clearInterval === "function"
    ? runtime.clearInterval
    : (() => {});
  const DateImpl = runtime.Date || Date;
  const MathImpl = runtime.Math || Math;
  const document = runtime.document || {
    getElementById(){ return null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(){
      return {
        dataset: {},
        classList: {add(){}, remove(){}, toggle(){}},
        setAttribute(){},
        appendChild(){},
        remove(){}
      };
    },
    documentElement: {appendChild(){}},
    body: {appendChild(){}}
  };
  const window = {
    DATA: data,
    __TKB_E2E_EXPOSE_TEST_HOOKS: true,
    document,
    localStorage,
    sessionStorage,
    navigator: {hardwareConcurrency: 8},
    location: Object.assign({
      protocol: "http:",
      hostname: "127.0.0.1",
      origin: "http://127.0.0.1:1010",
      href: "http://127.0.0.1:1010/pages/sapxep.html",
      pathname: "/pages/sapxep.html",
      search: ""
    }, runtime.location || {}),
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval: setIntervalImpl,
    clearInterval: clearIntervalImpl,
    requestAnimationFrame(callback){ return setTimeoutImpl(callback, 0); },
    requestIdleCallback(callback){ return setTimeoutImpl(callback, 0); },
    addEventListener: runtime.addEventListener || (() => {}),
    removeEventListener: runtime.removeEventListener || (() => {}),
    confirm: runtime.confirm || (() => true),
    alert(){},
    console: consoleImpl
  };
  window.window = window;

  const context = vm.createContext({
    window,
    document,
    localStorage,
    sessionStorage,
    navigator: window.navigator,
    location: window.location,
    console: consoleImpl,
    URLSearchParams,
    AbortController,
    Date: DateImpl,
    Math: MathImpl,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    fetch: fetchImpl || (async () => { throw new Error("Unexpected network request in pure bridge test"); }),
    DAYS: ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"],
    SANG: 5,
    CHIEU: 5
  });
  vm.runInContext(BRIDGE_SOURCE, context, {filename: BRIDGE_PATH});
  const hooks = window.__TKB_RUST_BRIDGE_TEST_HOOKS;
  assert.ok(hooks, "bridge test hooks must be exposed in E2E mode");
  return {window, hooks};
}

function jsonResponse(payload, status = 200){
  return {
    ok: status >= 200 && status < 300,
    status,
    async json(){ return payload; },
    clone(){ return jsonResponse(payload, status); }
  };
}

function detachedAbortError(message = "browser transport detached"){
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

test("watchdog and local fast finishes complete progress before releasing the button", () => {
  const forceBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("function forceFinishSolveUi"),
    BRIDGE_SOURCE.indexOf("function installFinishWatchdog")
  );
  assert.ok(forceBody.indexOf("finishProgress(") < forceBody.indexOf("releaseAutoSortButtonSoon()"));

  const localRepairBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("function finishLocalUnassignedRepairPayload"),
    BRIDGE_SOURCE.indexOf("function maybeFinishLocalUnassignedRepairSolve")
  );
  assert.ok(localRepairBody.indexOf('finishProgress("100%", "ok")') >= 0);
  assert.ok(localRepairBody.indexOf("finishProgress(") < localRepairBody.indexOf("releaseAutoSortButtonSoon()"));

  const offRestoreBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("function maybeFinishFastOffRestoreSolve"),
    BRIDGE_SOURCE.indexOf("async function solveWithRustApi")
  );
  assert.ok(offRestoreBody.indexOf('finishProgress("100%", "ok")') >= 0);
  assert.ok(offRestoreBody.indexOf("finishProgress(") < offRestoreBody.indexOf("releaseAutoSortButtonSoon()"));

  const busyButtonBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("function setAutoSortButtonBusy"),
    BRIDGE_SOURCE.indexOf("function startInstantProgressTicker")
  );
  assert.doesNotMatch(busyButtonBody, /btn\.textContent\s*=/, "busy state must preserve the SVG Play icon");
  assert.match(busyButtonBody, /setAttribute\("aria-busy",\s*busy \? "true" : "false"\)/);
});

test("progress appears for Play and hides after a successful terminal state", () => {
  const hardFinishBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("function hardFinishProgressDom"),
    BRIDGE_SOURCE.indexOf("function finishProgress")
  );
  const idleBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("function hideAutoSortProgressDom"),
    BRIDGE_SOURCE.indexOf("function autoSortProgressFinishedInDom")
  );
  const primeBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("function primeAutoSortStartUi"),
    BRIDGE_SOURCE.indexOf("function releaseAutoSortButtonSoon")
  );

  assert.doesNotMatch(hardFinishBody, /setTimeout\s*\(/, "terminal progress must not schedule its own disappearance");
  assert.match(hardFinishBody, /text\.textContent\s*=\s*needsAttention[\s\S]*?:\s*"Hoàn tất"/);
  assert.match(idleBody, /classList\.add\("is-idle"\)/);
  assert.match(idleBody, /wrap\.hidden\s*=\s*true/);
  assert.match(idleBody, /setAttribute\("aria-hidden",\s*"true"\)/);
  assert.match(idleBody, /pct\.textContent\s*=\s*"0%"/);
  assert.match(idleBody, /text\.textContent\s*=\s*"Sẵn sàng"/);
  assert.match(primeBody, /setProgress\(0,\s*"Chuẩn bị",\s*\{replaceLocalPercent:true,\s*phase:"preparing"\}\)/);
  assert.doesNotMatch(primeBody, /hideAutoSortProgressDom\(\)/);
});

test("automatic sorting paints progress and slices validation before starting the solver", () => {
  const body = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"),
    BRIDGE_SOURCE.indexOf("const autoSortButton", BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"))
  );
  assert.match(body, /primeAutoSortStartUi\(\);\s*await waitForUiPaint\(\);/);
  assert.ok(body.indexOf("await waitForUiPaint()") < body.indexOf("scheduleFingerprintFromData(data)"));
  assert.match(body, /scheduleFingerprintFromData\(data\);\s*await yieldResponsiveUi\(\);/);
  assert.match(body, /snapshotScheduleData\(data\);\s*await yieldResponsiveUi\(\);/);
  assert.match(
    body,
    /await currentConstraintViolationsAsync\(3000,\s*\{\s*allowSyncFallback:false\s*\}\);\s*if\(isStopRequested\(\)/
  );
  assert.match(body, /if\(violationsBeforeRepair\?\.stale === true\)\{\s*reportAutoSortPreparationChanged\(\)/);
  assert.doesNotMatch(body, /await buildTeacherReleaseCellIndexAsync\(data/);
  assert.doesNotMatch(body, /releaseConstraintViolatingLessons\(data/);
  assert.match(body, /const releasedForConstraintRepair = 0/);
  assert.match(body, /violationsForAutomaticPlan\.length > 0[\s\S]*?buildConstraintRepairAutoSortPlan/);
  assert.match(body, /autoSortPreparationMatches\(data, scheduleFingerprintBefore\)/);
  assert.match(body, /sourceScheduleFingerprint:planningScheduleFingerprint/);
  assert.match(body, /const planningMemoToken = beginAutoSortPlanningMemo\(data\);\s*let expected;\s*let automaticPlan;\s*try\{\s*expected = expectedLessonCount\(data\)/);
  assert.ok(body.indexOf("beginAutoSortPlanningMemo(data)") < body.indexOf("expected = expectedLessonCount(data)"));
  assert.match(body, /buildFreshQualityAutoSortSettings\(data, expected, "balanced"\);\s*traceSolveStep\("auto-sort:fresh-settings-ready"/);
  assert.match(body, /await yieldResponsiveUi\(\);\s*if\(isStopRequested\(\)\)/);
  assert.match(body, /buildAutomaticAutoSortPlan\([\s\S]*?violationsForAutomaticPlan\.length,[\s\S]*?preparedFreshPlan/);
  assert.doesNotMatch(body, /const violationsBeforeRepair = currentConstraintViolations\(/);
});

test("Play advances elapsed time and progress before VPS admission", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const progress = createProgressDocument(clock);
  const {window, hooks} = loadBridge(data, null, Object.assign({}, clock, {
    document:progress.document,
    enableIntervals:true
  }));

  hooks.primeAutoSortStartUi();
  clock.advance(1_000);
  const afterOneSecond = window.__TKB_RUST_PROGRESS_STATE;
  assert.equal(afterOneSecond.label, "1 giây");
  assert.equal(afterOneSecond.phase, "preparing");
  assert.equal(afterOneSecond.canonicalServerProgress, false);
  assert.equal(afterOneSecond.serverStartedAtMs, 0);
  assert.ok(afterOneSecond.percent > 3, `pre-admission progress must move after one second: ${afterOneSecond.percent}`);
  assert.equal(afterOneSecond.updatedAt, clock.now());
});

test("a fresh Play shows an immediate preparation frame before timed progress", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const progress = createProgressDocument(clock);
  const {window, hooks} = loadBridge(data, null, Object.assign({}, clock, {
    document:progress.document,
    enableIntervals:true
  }));
  const visibleProgressCalls = [];
  window.setAutoSortProgress = (percent, label) => {
    visibleProgressCalls.push({percent:Number(percent), label:String(label), at:clock.now()});
    progress.wrap.hidden = false;
    progress.wrap.classList.add("is-active");
    progress.pct.textContent = `${Math.round(Number(percent) || 0)}%`;
    progress.label.textContent = String(label || "");
  };

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker({
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    progress_estimate_seconds:60,
    overall_time_limit_seconds:60,
    backend_deadline_ms:60_000
  }, data);

  assert.equal(progress.button.disabled, true, "Play must lock immediately on click");
  assert.equal(progress.button.classList.contains("is-busy"), true);
  assert.equal(progress.button.getAttribute("aria-busy"), "true");
  assert.equal(progress.wrap.hidden, false, "the reserved progress frame must be visible at t=0");
  assert.deepEqual(visibleProgressCalls, [{percent:0, label:"Chuẩn bị", at:clock.now()}]);

  clock.advance(999);
  assert.equal(progress.wrap.hidden, false);
  assert.equal(visibleProgressCalls.length, 1);

  clock.advance(1);
  assert.equal(progress.wrap.hidden, false);
  assert.ok(visibleProgressCalls.length >= 2);
  const timedProgressCalls = visibleProgressCalls.slice(1);
  assert.ok(timedProgressCalls.every(call => call.at === clock.now()));
  assert.ok(timedProgressCalls.every(call => call.label === "1 giây"));
  assert.ok(timedProgressCalls[0].percent > 3);
  const status = progress.nodes.get("statusMsg");
  assert.equal(status.textContent, "Đang sắp xếp...");
  assert.notEqual(status.style.display, "none");

  clock.advance(1_000);
  assert.equal(visibleProgressCalls.at(-1).label, "2 giây");
  assert.ok(visibleProgressCalls.at(-1).percent >= timedProgressCalls[0].percent);
});

test("a synchronous five-second preflight keeps its preparation frame until timed paint can run", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const progress = createProgressDocument(clock);
  const {window, hooks} = loadBridge(data, null, Object.assign({}, clock, {
    document:progress.document,
    enableIntervals:true
  }));
  const visibleProgressCalls = [];
  window.setAutoSortProgress = (percent, label) => {
    visibleProgressCalls.push({percent:Number(percent), label:String(label), at:clock.now()});
    progress.wrap.hidden = false;
  };

  hooks.primeAutoSortStartUi();
  assert.equal(progress.wrap.hidden, false);
  assert.deepEqual(visibleProgressCalls, [{percent:0, label:"Chuẩn bị", at:clock.now()}]);

  // Wall time can pass while synchronous JavaScript owns the main thread, but
  // interval callbacks and DOM updates cannot execute until that work yields.
  clock.elapseWithoutTasks(5_000);
  assert.equal(progress.wrap.hidden, false);
  assert.equal(visibleProgressCalls.length, 1);

  clock.flushDueTimers();
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.percent, 9);
  assert.match(window.__TKB_RUST_PROGRESS_STATE.label, /5 gi.y$/u);
  const visibleLabels = visibleProgressCalls.map(event => event.label);
  assert.equal(
    visibleLabels.some(label => /[1-4] gi.y$/u.test(label)),
    false,
    `a starved event loop must skip the intermediate paints: ${visibleLabels.join(" | ")}`
  );
});

test("automatic-sort preflight never deep-clones a stale full solver payload", () => {
  const body = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"),
    BRIDGE_SOURCE.indexOf("const autoSortButton", BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"))
  );

  assert.doesNotMatch(
    body,
    /clonePlain\(\s*data\?\.tkbSolverResult\s*\|\|\s*data\?\.tkbRustSolverResult/s,
    "Play must not synchronously stringify and parse the previous full solver result"
  );
});

test("automatic-sort validation preserves stale state without a synchronous fallback", async () => {
  const data = makeData(2);
  const {window, hooks} = loadBridge(data);
  let asyncCalls = 0;
  let syncCalls = 0;
  window.TKBConstraints = {
    async validateAllAsync(){
      asyncCalls += 1;
      const result = [];
      result.stale = true;
      return result;
    },
    validateAll(){
      syncCalls += 1;
      return [{message:"must not run"}];
    }
  };

  const result = await hooks.currentConstraintViolationsAsync(3000, {
    allowSyncFallback:false
  });

  assert.equal(asyncCalls, 2);
  assert.equal(syncCalls, 0);
  assert.equal(result.stale, true);
});

test("result application is async, sliced, and never falls back to synchronous validation", () => {
  const applyStart = BRIDGE_SOURCE.indexOf("async function applyPayload(payload)");
  const applyEnd = BRIDGE_SOURCE.indexOf("async function postSolve", applyStart);
  assert.ok(applyStart >= 0 && applyEnd > applyStart, "async applyPayload body must be extractable");
  const applyBody = BRIDGE_SOURCE.slice(applyStart, applyEnd);

  assert.match(applyBody, /const yieldApplySlice = async force =>/);
  assert.match(applyBody, /for\(const lesson of payloadLessons\)[\s\S]*?await yieldApplySlice\(false\)/);
  assert.match(applyBody, /await buildTeacherReleaseCellIndexAsync\(data,\s*\{[\s\S]*?sliceBudgetMs:8/);
  assert.match(
    applyBody,
    /await currentConstraintViolationsAsync\(3000,\s*\{\s*allowSyncFallback:false,\s*ignoreStop:true\s*\}\)/
  );
  assert.match(
    applyBody,
    /releaseConstraintViolatingLessons\(data,\s*\{[\s\S]*?violations:postApplyViolations,[\s\S]*?teacherCellIndex:teacherIndexResult\?\.index/
  );
  assert.doesNotMatch(applyBody, /currentConstraintViolations\(/);

  const solveStart = BRIDGE_SOURCE.indexOf("async function solveWithRustApi");
  const solveEnd = BRIDGE_SOURCE.indexOf(
    "try{\n    if(window.__TKB_E2E_EXPOSE_TEST_HOOKS",
    solveStart
  );
  const solveBody = BRIDGE_SOURCE.slice(solveStart, solveEnd);
  assert.match(solveBody, /result = await applyPayload\(payload\)/);
});

test("result application force-saves through the trusted fast path", async () => {
  const {data, payload} = makeLargeApplyFixture(1, 3);
  const {window} = loadBridge(data);
  const saveCalls = [];
  window.saveStore = options => {
    saveCalls.push(JSON.parse(JSON.stringify(options || {})));
    return true;
  };

  await window.TKBRustAPI.applyPayload(payload);

  assert.equal(saveCalls.length, 1);
  assert.deepEqual(saveCalls[0], {
    force:true,
    trustedSolverApply:true,
    knownStats:{
      total:3,
      assigned:3,
      missing:0
    }
  });

  const saveStart = PLANNER_SOURCE.indexOf("function saveStore(options)");
  const saveEnd = PLANNER_SOURCE.indexOf("function deferInitialHistorySnapshot", saveStart);
  const saveBody = PLANNER_SOURCE.slice(saveStart, saveEnd);
  assert.match(saveBody, /const trustedSolverApply = opts\.trustedSolverApply === true/);
  assert.match(saveBody, /if\(!trustedSolverApply\)[\s\S]*?reapplyAllUserOffLocks\(\)/);
  assert.match(saveBody, /if\(!trustedSolverApply\)[\s\S]*?sanitizePlannerDataFromIndex\(\)/);

  const payloadStart = PLANNER_SOURCE.indexOf("function __tkbPayloadForSave(options)");
  const payloadEnd = PLANNER_SOURCE.indexOf("function saveStore(options)", payloadStart);
  const payloadBody = PLANNER_SOURCE.slice(payloadStart, payloadEnd);
  assert.match(payloadBody, /opts\.trustedSolverApply === true[\s\S]*?opts\.knownStats/);
  assert.match(payloadBody, /hasKnownStats[\s\S]*?: __tkbCurrentSaveStats\(\)/);
});

test("a completed server-owned solve result is decoded exactly once across polling and consumption", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let jsonCalls = 0;
  const finalPayload = {
    ok:true,
    lessons:[],
    unassignedLessons:[],
    metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
    validation:{hard_ok:true},
    solver:{runtime_settings:{}}
  };
  const makeCountedResponse = () => ({
    ok:true,
    status:200,
    async json(){
      jsonCalls += 1;
      return finalPayload;
    },
    clone(){ return makeCountedResponse(); }
  });
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      const jobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId,
        retryAfterMs:250
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")) return makeCountedResponse();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, clock);

  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);
  assert.equal(payload.ok, true);
  assert.equal(jsonCalls, 1, "polling and postSolve must share the one decoded final payload");
});

test("hidden timetable statistics stay lazy while opening the popover still renders them", () => {
  const loadStart = PLANNER_SOURCE.indexOf("function loadMonList(){");
  const loadEnd = PLANNER_SOURCE.indexOf("/* ======================= CH", loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "loadMonList body must be extractable");
  const loadBody = PLANNER_SOURCE.slice(loadStart, loadEnd);
  const monList = {
    innerHTML:"",
    appendChild(){},
    querySelectorAll(){ return []; }
  };
  const statsPopover = {hidden:true};
  let renderCalls = 0;
  const loadContext = {
    TKB_LOAD_MON_LIST_TIMER:0,
    TKB_LOAD_MON_LIST_LAST_AT:-Infinity,
    clearTimeout(){},
    setTimeout(){ return 1; },
    document:{
      getElementById(id){
        if(id === "monList") return monList;
        if(id === "statsPopover") return statsPopover;
        return null;
      },
      createElement(){ return {style:{}, classList:{toggle(){}}, dataset:{}, appendChild(){}}; }
    },
    VIEW_MODE:"lop",
    currentLop:"",
    DATA:{lop:[]},
    collectUnassignedTasks(){ return []; },
    extractKhoiNumber(){ return ""; },
    updateUnassignedSummary(){},
    currentClassUnassignedFallback(){ return 0; },
    renderStatsBox(){ renderCalls += 1; }
  };
  vm.runInNewContext(`${loadBody}\nloadMonList();`, loadContext);
  assert.equal(renderCalls, 0, "a scheduled list refresh must leave hidden whole-school statistics untouched");

  const openStart = PLANNER_SOURCE.indexOf("function setStatsPopoverOpen(open)");
  const openEnd = PLANNER_SOURCE.indexOf("function closeStatsPopover", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, "setStatsPopoverOpen body must be extractable");
  const openBody = PLANNER_SOURCE.slice(openStart, openEnd);
  const button = {
    classList:{toggle(){}},
    setAttribute(){}
  };
  const openContext = {
    document:{
      getElementById(id){
        if(id === "statsPopover") return statsPopover;
        if(id === "statsToggle") return button;
        return null;
      }
    },
    renderStatsBox(){ renderCalls += 1; },
    requestAnimationFrame(){},
    positionStatsPopover(){}
  };
  vm.runInNewContext(`${openBody}\nsetStatsPopoverOpen(true);`, openContext);
  assert.equal(statsPopover.hidden, false);
  assert.equal(renderCalls, 1, "opening the statistics popover must render its current values on demand");
});

test("result-apply progress keeps updating the visible elapsed time", () => {
  const labelStart = BRIDGE_SOURCE.indexOf("function progressLabel");
  const labelEnd = BRIDGE_SOURCE.indexOf("function stopProgressTicker", labelStart);
  const labelBody = BRIDGE_SOURCE.slice(labelStart, labelEnd);
  assert.match(labelBody, /const elapsed = formatLiveDuration\(elapsedSeconds\);\s*return elapsed;/);
  assert.doesNotMatch(labelBody, /backendProgressStageLabel\(/);

  const tickStart = BRIDGE_SOURCE.indexOf("function tickEstimatedProgress");
  const tickEnd = BRIDGE_SOURCE.indexOf("function startProgressTicker", tickStart);
  const tickBody = BRIDGE_SOURCE.slice(tickStart, tickEnd);
  assert.match(
    tickBody,
    /progressState\.phase === "result_apply"[\s\S]*?progressLabel\(\s*"result_apply",\s*visibleElapsedSeconds\s*\)[\s\S]*?setProgress\(applyPercent/
  );
});

test("post-completion checks reuse applied validation metrics and skip complete local repair", () => {
  const completionStart = BRIDGE_SOURCE.indexOf("function currentScheduleAppearsComplete");
  const completionEnd = BRIDGE_SOURCE.indexOf("function autoSortPreparationMatches", completionStart);
  assert.ok(completionStart >= 0 && completionEnd > completionStart);
  const completionBody = BRIDGE_SOURCE.slice(completionStart, completionEnd);
  assert.match(completionBody, /metrics\.app_constraint_violation_count/);
  assert.doesNotMatch(completionBody, /currentConstraintViolations\(/);

  const solveStart = BRIDGE_SOURCE.indexOf("async function solveWithRustApi");
  const solveEnd = BRIDGE_SOURCE.indexOf(
    "try{\n    if(window.__TKB_E2E_EXPOSE_TEST_HOOKS",
    solveStart
  );
  const solveBody = BRIDGE_SOURCE.slice(solveStart, solveEnd);
  assert.match(
    solveBody,
    /const localRepairAfterPayload = metricNumber\(payload\?\.metrics\?\.unassigned_periods, 0\) > 0\s*\? autoPlaceUnassignedFromUi\("after_payload", \{maxPlace: 24\}\)\s*: null/
  );
});

test("large result application stays responsive and uses only sliced validation", async () => {
  const {data, payload} = makeLargeApplyFixture(40, 29);
  const {window, hooks} = loadBridge(data);
  let synchronousValidationCalls = 0;
  let asyncValidationCalls = 0;
  const validationBudgets = [];
  window.TKBConstraints = {
    get(){ return {}; },
    validateAll(){
      synchronousValidationCalls += 1;
      throw new Error("result application must not synchronously validate the whole school");
    },
    async validateAllAsync(_max, options){
      asyncValidationCalls += 1;
      validationBudgets.push(Number(options?.sliceBudgetMs || 0));
      await new Promise(resolve => setTimeout(resolve, 75));
      return [];
    }
  };

  const heartbeatTimes = [Date.now()];
  const heartbeat = setInterval(() => heartbeatTimes.push(Date.now()), 10);
  let result;
  try{
    const pending = window.TKBRustAPI.applyPayload(payload);
    assert.equal(typeof pending?.then, "function");
    result = await pending;
    await new Promise(resolve => setTimeout(resolve, 30));
  }finally{
    clearInterval(heartbeat);
  }

  const heartbeatGaps = heartbeatTimes.slice(1).map((time, index) => time - heartbeatTimes[index]);
  assert.equal(synchronousValidationCalls, 0);
  assert.equal(asyncValidationCalls, 1);
  assert.deepEqual(validationBudgets, [8]);
  assert.equal(result.lessons.length, 40 * 29);
  assert.equal(hooks.countScheduledLessons(data), 40 * 29);
  assert.ok(heartbeatTimes.length >= 4, "result application must yield often enough for the UI heartbeat");
  assert.ok(
    Math.max(...heartbeatGaps) <= 250,
    `result application blocked the UI heartbeat for ${Math.max(...heartbeatGaps)} ms`
  );

  for(const cls of payload.classes){
    let scheduled = 0;
    for(const day of Object.values(data.tkb[cls.id] || {})){
      for(const session of [day?.sang, day?.chieu]){
        scheduled += (session || []).filter(Boolean).length;
      }
    }
    assert.equal(scheduled, 29, `${cls.id} must retain all 29 lessons`);
  }
});

test("a second automatic-sort call is suppressed while the first preflight is yielding", async () => {
  const data = makeData(2);
  const {window, hooks} = loadBridge(data);

  const first = window.sapXepTuDongAll();
  assert.equal(hooks.autoSortPreflightActive(), true);
  assert.equal(hooks.localSolveLifecycleActive(), true);

  const second = await window.sapXepTuDongAll();
  assert.equal(second, null);
  assert.equal(hooks.autoSortPreflightActive(), true, "the rejected call must not release the first run's token");

  window.__AUTO_SORT_STOP_REQUESTED = true;
  assert.equal(await first, null);
  assert.equal(hooks.autoSortPreflightActive(), false);
  assert.equal(hooks.localSolveLifecycleActive(), false);
});

test("automatic-sort preflight lock is released by an early busy exit", async () => {
  const data = makeData(2);
  const {window, hooks} = loadBridge(data);
  window.__TKB_SOLVE_UI_BUSY = true;

  assert.equal(await window.sapXepTuDongAll(), null);
  assert.equal(hooks.autoSortPreflightActive(), false);
  assert.equal(window.__TKB_AUTO_SORT_PREFLIGHT_ACTIVE, false);

  window.__TKB_SOLVE_UI_BUSY = false;
  assert.equal(hooks.localSolveLifecycleActive(), false);
});

test("automatic-sort preflight rejects an in-place timetable edit made while validation yields", async () => {
  const data = makeData(2);
  const {window, hooks} = loadBridge(data);
  window.TKBConstraints = {
    async validateAllAsync(){
      data.tkb.L1 = {
        thu2:{sang:["ToÃ¡n"], chieu:[]}
      };
      return [];
    }
  };

  assert.equal(await window.sapXepTuDongAll(), null);
  assert.equal(hooks.autoSortPreflightActive(), false);
  assert.equal(hooks.localSolveLifecycleActive(), false);
  assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG, undefined);
});

test("constraint-repair teacher indexing yields while scanning a large timetable", async () => {
  const data = makeData(2);
  data.lop = [];
  data.pccmMatrix = {};
  data.pccmTietMatrix = {};
  data.tkb = {};
  for(let classIndex = 0; classIndex < 40; classIndex += 1){
    const classId = `L${classIndex + 1}`;
    data.lop.push({id:classId, ten:classId, ten2:classId, khoi:"10"});
    data.pccmMatrix[`${classId}|ToÃ¡n`] = "GV01";
    data.pccmTietMatrix[`${classId}|ToÃ¡n`] = 2;
    data.tkb[classId] = {};
    for(const day of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
      data.tkb[classId][day] = {
        sang:Array(10).fill("ToÃ¡n"),
        chieu:Array(10).fill("ToÃ¡n")
      };
    }
  }

  let clockMs = 0;
  let scheduledYields = 0;
  class AdvancingDate extends Date {
    static now(){ clockMs += 5; return clockMs; }
  }
  const {hooks} = loadBridge(data, null, {
    Date:AdvancingDate,
    setTimeout(callback){
      scheduledYields += 1;
      Promise.resolve().then(callback);
      return scheduledYields;
    },
    clearTimeout(){}
  });
  const yieldsBeforeIndex = scheduledYields;
  const result = await hooks.buildTeacherReleaseCellIndexAsync(data, {sliceBudgetMs:4});

  assert.equal(result.cancelled, false);
  assert.equal(result.index.get("gv01")?.length, 4800);
  assert.ok(scheduledYields > yieldsBeforeIndex, "the teacher index must yield to the UI");
});

test("automatic plan reuses a known preflight result without another full constraint scan", () => {
  const data = makeData(2);
  const {window, hooks} = loadBridge(data);
  let synchronousScans = 0;
  window.TKBConstraints = {
    validateAll(){
      synchronousScans += 1;
      return [];
    }
  };

  const plan = hooks.buildAutomaticAutoSortPlan(data, undefined, 0);

  assert.equal(synchronousScans, 0);
  assert.equal(plan.settings.ui_preflight_constraint_violation_count, 0);
  const solveBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("async function solveWithRustApi"),
    BRIDGE_SOURCE.indexOf("try{\n    if(window.__TKB_E2E_EXPOSE_TEST_HOOKS", BRIDGE_SOURCE.indexOf("async function solveWithRustApi"))
  );
  assert.match(solveBody, /knownPreflightViolationCount[\s\S]*?currentConstraintViolations\(1\)/);
});

test("empty timetable planning does not call whole-school UI statistics", () => {
  const data = makeData(2);
  const {window, hooks} = loadBridge(data);
  let uiStatsCalls = 0;
  window.calcSchoolTKBStats = () => {
    uiStatsCalls += 1;
    throw new Error("empty timetable planning must stay on lightweight counters");
  };

  const plan = hooks.buildAutomaticAutoSortPlan(data, undefined, 0);

  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(uiStatsCalls, 0);
});

test("expectedLessonCount observes same-length PCCM period edits", () => {
  const data = makeData(2);
  const {hooks} = loadBridge(data);
  assert.equal(hooks.expectedLessonCount(data), 2);

  data.pccmTietMatrix["L1|Toán"] = 3;
  assert.equal(hooks.expectedLessonCount(data), 3);

  const plan = hooks.buildFreshQualityAutoSortSettings(data, undefined, "fast");
  assert.equal(plan.settings.expected_scheduled_periods, 3);
});

test("planner exposes one automatic arrange button and one accessible seconds duration input", () => {
  assert.equal((PLANNER_HTML.match(/id="btnAutoSort"/g) || []).length, 1);
  const selectTags = PLANNER_HTML.match(/<select\b[^>]*>/gi) || [];
  assert.equal(selectTags.length, 1);
  assert.match(selectTags[0], /id="chonKhoi"/);
  assert.match(selectTags[0], /\bhidden\b/);
  assert.doesNotMatch(PLANNER_HTML, /id="solverPresetGroup"/);
  assert.doesNotMatch(PLANNER_HTML, /id="solverPreset"/);
  assert.doesNotMatch(PLANNER_HTML, /id="tkbBackendBanner"/);
  assert.doesNotMatch(PLANNER_HTML, /Dịch vụ xếp lịch chưa chạy/);
  assert.doesNotMatch(PLANNER_HTML, /\b(?:1|2|3)\s*ph[uú]t\b/i);
  assert.equal((PLANNER_HTML.match(/id="solveDurationSeconds"/g) || []).length, 1);
  const durationTag = PLANNER_HTML.match(/<input\b[^>]*id="solveDurationSeconds"[^>]*>/i)?.[0] || "";
  assert.match(durationTag, /type="number"[^>]*min="10"[^>]*max="1800"[^>]*aria-label="[^"]*giây[^"]*"/i);
  assert.doesNotMatch(durationTag, /\bvalue=|\bplaceholder=|\btitle=/i);
});

test("an empty duration field uses 60 seconds fresh and 180 seconds for refinement", () => {
  const storage = memoryStorage();
  const durationInput = {
    value:"",
    dataset:{},
    disabled:false,
    addEventListener(){},
    removeEventListener(){},
    setAttribute(){},
    removeAttribute(){}
  };
  const document = {
    getElementById(id){ return id === "solveDurationSeconds" ? durationInput : null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(){ return {dataset:{}, classList:{add(){}, remove(){}, toggle(){}}, setAttribute(){}, appendChild(){}, remove(){}}; },
    documentElement:{appendChild(){}},
    body:{appendChild(){}}
  };
  const data = makeData(2);
  const {window, hooks} = loadBridge(data, null, {localStorage:storage, document});

  const first = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(durationInput.dataset.durationMode, "auto");
  assert.equal(durationInput.value, "");
  assert.equal(first.kind, "fresh_complete_first");
  assert.equal(first.settings.overall_time_limit_seconds, 60);
  assert.equal(first.settings.backend_deadline_ms, 60000);
  assert.equal(first.settings.native_global_deadline_ms, 60000);
  assert.equal(first.settings.optimization_continue_quality_search, false);
  assert.equal(first.settings.optimization_first_click_quality_time_limit_seconds, 30);
  assert.equal(first.settings.ui_allow_incomplete_retry_after_single_pass, false);
  assert.equal(first.settings.ui_stop_after_first_complete_schedule, false);
  assert.equal(first.settings.optimization_first_click_continue_local_after_complete, true);
  assert.equal(first.settings.optimization_first_click_skip_global_quality, false);
  assert.equal(first.settings.optimization_first_click_lean_global_quality, true);
  assert.equal(first.settings.optimization_first_click_quality_stop_at_cap, true);
  assert.equal(first.settings.optimization_first_click_local_lns_time_limit_seconds, 18);
  assert.equal(first.settings.ui_disable_automatic_retry, true);
  assert.equal(first.settings.complete_schedule_seed_retry_max_runs, 0);
  assert.notEqual(first.settings.optimization_benders_lean_refinement_periods, true);

  data.tkb = {L1:{thu2:{sang:[{mon:"Toán"}, {mon:"Toán"}, "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
    validation:{hard_ok:true},
    solver:{runtime_settings:{}}
  };
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});

  const second = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(second.kind, "refine_complete");
  assert.equal(second.settings.optimization_refinement_round, 1);
  assert.equal(durationInput.value, "");
  assert.equal(second.settings.overall_time_limit_seconds, 180);
  assert.equal(second.settings.backend_deadline_ms, 180000);
  assert.equal(second.settings.native_global_deadline_ms, 180000);
  assert.equal(second.settings.optimization_benders_lean_refinement_periods, true);
  assert.equal(second.settings.optimization_continue_quality_search, true);
  assert.equal(second.settings.ui_stop_refinement_when_good_enough, false);
  assert.equal(second.settings.optimization_stop_on_stagnation, true);
  assert.equal(second.settings.optimization_benders_accept_stagnant_iterations, 2);
  assert.equal(second.settings.ui_existing_incumbent_revalidated, true);
  assert.equal(second.settings.ui_return_complete_incumbent_on_existing_optimize_failure, true);

  data.tkbSolverResult.metrics.optimization_refinement_round = 1;
  data.tkbSolverResult.solver.runtime_settings.optimization_refinement_round = 1;
  const third = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(third.settings.optimization_refinement_round, 2);
  assert.equal(durationInput.value, "");
  assert.equal(third.settings.overall_time_limit_seconds, 180);
  assert.equal(third.settings.backend_deadline_ms, 180000);
  assert.equal(third.settings.native_global_deadline_ms, 180000);

  data.tkbSolverResult.metrics.optimization_refinement_round = 2;
  data.tkbSolverResult.solver.runtime_settings.optimization_refinement_round = 2;
  const later = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(later.settings.optimization_refinement_round, 3);
  assert.equal(durationInput.value, "");
  assert.equal(later.settings.overall_time_limit_seconds, 180);
});

test("a severely rough complete timetable rebuilds once from fixed lessons in the fresh 60-second lane", () => {
  const data = makeData(300);
  const subject = data.mon[0].ten;
  const fixedLesson = {mon:subject, fixed:true};
  data.tkb = {
    L1:{thu2:{sang:[fixedLesson, ...Array(299).fill(subject)], chieu:[]}}
  };
  data.tkbConstraints = {
    fixedOff:{class:{L1:{"thu7|chieu|4":true}}}
  };
  data.tkbUserOff = {L1:["thu7|chieu|4"]};
  const constraintsBefore = JSON.parse(JSON.stringify(data.tkbConstraints));
  const userOffBefore = JSON.parse(JSON.stringify(data.tkbUserOff));
  data.tkbSolverResult = {
    lessons:Array.from({length:300}, (_, index) => ({
      classId:"L1", subject, teacher:"GV01", day:2, session:"AM", period:index + 1
    })),
    metrics:{
      scheduled_periods:300,
      expected_periods:300,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      teacher_sessions:100,
      one_period_teacher_sessions:1,
      gap_distribution:{"0":100}
    },
    validation:{hard_ok:true},
    solver:{runtime_settings:{}}
  };
  const {window, hooks} = loadBridge(data);
  window.calcSchoolTKBStats = () => ({soTiet:300, daXepTiet:300, chuaXepTiet:0});

  const plan = hooks.buildAutomaticAutoSortPlan(data, undefined, 0);
  const effective = hooks.effectiveSettingsForSolve(plan.settings, data);
  const requestData = hooks.dataForSolverRequest(data, plan.settings);

  assert.equal(plan.kind, "refine_complete", "the client still compares the rebuilt candidate with its incumbent");
  assert.equal(plan.qualityDebtFreshRebuild, true);
  assert.equal(plan.settings.ui_unified_solve_kind, "fresh_complete_first");
  assert.equal(plan.settings.ui_quality_debt_fresh_rebuild, true);
  assert.equal(plan.settings.overall_time_limit_seconds, 60);
  assert.equal(plan.settings.backend_deadline_ms, 60000);
  assert.equal(plan.settings.preserve_existing_tkb, false);
  assert.equal(plan.settings.allow_solver_warm_start, false);
  assert.equal(
    effective.ui_keep_better_existing_on_resort,
    true,
    "the normalized no-hint request must retain the incumbent quality guard"
  );
  assert.equal(requestData.tkbSolverResult, undefined);
  assert.equal(requestData.__tkbRequestStrippedSchedule, true);
  assert.equal(requestData.__tkbRequestFixedScheduleOnly, true);
  assert.equal(JSON.stringify(requestData.tkb.L1.thu2.sang[0]), JSON.stringify(fixedLesson));
  assert.equal(JSON.stringify(requestData.tkbConstraints), JSON.stringify(constraintsBefore));
  assert.equal(JSON.stringify(requestData.tkbUserOff), JSON.stringify(userOffBefore));
});

test("quality-debt rebuild threshold separates a rough 522-session result from a practical 481-session result", () => {
  const data = makeData(1566);
  const payload = (teacherSessions, gap1, onePeriod = 0, gap2 = 0) => ({
    metrics:{
      scheduled_periods:1566,
      expected_periods:1566,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      teacher_sessions:teacherSessions,
      one_period_teacher_sessions:onePeriod,
      gap_distribution:{"0":Math.max(0, teacherSessions - gap1 - gap2), "1":gap1, "2":gap2}
    },
    validation:{hard_ok:true}
  });
  const {hooks} = loadBridge(data);
  const targets = {teacherTarget:482, gap1Target:53};

  data.tkbSolverResult = payload(522, 118);
  assert.equal(hooks.completeScheduleNeedsFreshQualityRebuild(data, targets), true);
  data.tkbSolverResult = payload(481, 53);
  assert.equal(hooks.completeScheduleNeedsFreshQualityRebuild(data, targets), false);
  data.tkbSolverResult = payload(481, 53, 1, 0);
  assert.equal(hooks.completeScheduleNeedsFreshQualityRebuild(data, targets), true);
});

test("failed blank fresh clicks add five seconds without changing the user input", () => {
  const storage = memoryStorage();
  const durationInput = {
    value:"",
    dataset:{},
    disabled:false,
    addEventListener(){},
    removeEventListener(){},
    setAttribute(){},
    removeAttribute(){}
  };
  const document = {
    getElementById(id){ return id === "solveDurationSeconds" ? durationInput : null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    createElement(){ return {dataset:{}, classList:{add(){}, remove(){}, toggle(){}}, setAttribute(){}, appendChild(){}, remove(){}}; },
    documentElement:{appendChild(){}},
    body:{appendChild(){}}
  };
  const data = makeData(2);
  const {window, hooks} = loadBridge(data, null, {localStorage:storage, document});
  const internalSaves = [];
  window.saveStore = options => internalSaves.push(options);
  const failure = Object.assign(new Error("deadline before complete schedule"), {
    kind:"no_complete_schedule_before_deadline"
  });

  const first = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(first.settings.backend_deadline_ms, 60_000);
  assert.equal(durationInput.value, "");
  assert.equal(durationInput.dataset.durationMode, "auto");

  assert.equal(hooks.rememberManualFreshRetryFailure(data, first.settings, failure), 65);
  assert.deepEqual(JSON.parse(JSON.stringify(internalSaves)), [{force:true, suppressHistory:true}]);
  const second = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(second.settings.backend_deadline_ms, 65_000);
  assert.equal(second.settings.ui_manual_fresh_retry_seconds, 65);
  assert.equal(second.settings.ui_manual_fresh_retry_failures, 1);
  assert.equal(durationInput.value, "");
  assert.equal(durationInput.dataset.durationMode, "auto");

  assert.equal(hooks.rememberManualFreshRetryFailure(data, second.settings, failure), 70);
  const third = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(third.settings.backend_deadline_ms, 70_000);
  assert.equal(third.settings.ui_manual_fresh_retry_seconds, 70);
  assert.equal(durationInput.value, "");

  hooks.writeCustomSolveDurationSeconds(90);
  const custom = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(custom.settings.backend_deadline_ms, 90_000);
  assert.equal(custom.settings.ui_manual_fresh_retry_seconds, undefined);
  assert.equal(hooks.rememberManualFreshRetryFailure(data, custom.settings, failure), 0);
  assert.equal(durationInput.value, "90");

  hooks.writeCustomSolveDurationSeconds("");
  assert.equal(hooks.clearManualFreshRetryBudget(data), true);
  const reset = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(reset.settings.backend_deadline_ms, 60_000);
  assert.equal(durationInput.value, "");
  assert.equal(durationInput.dataset.durationMode, "auto");
});

test("a complete timetable starts only one blank-field adaptive refinement without a confirmation", () => {
  const data = makeData(2);
  const subject = data.mon[0].ten;
  data.tkb = {L1:{thu2:{sang:[{mon:subject}, {mon:subject}, "", "", ""]}}};
  const prompts = [];
  const {window, hooks} = loadBridge(data, null, {
    confirm(message){ prompts.push(String(message || "")); return true; }
  });
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(plan.kind, "refine_complete");
  assert.equal(plan.settings.overall_time_limit_seconds, 180);
  assert.equal(plan.settings.backend_deadline_ms, 180000);
  assert.equal(plan.settings.native_global_deadline_ms, 180000);
  assert.deepEqual(prompts, []);

  const body = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"),
    BRIDGE_SOURCE.indexOf("const autoSortButton", BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"))
  );
  assert.doesNotMatch(body, /confirmResortCompleteSchedule|window\.confirm|scheduleOptimizeAfterCompletePrompt/);
});

test("custom seconds duration is persisted, clamped, and overrides automatic solve budgets", () => {
  const storage = memoryStorage();
  storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", "275");
  const data = makeData(2);
  const {hooks} = loadBridge(data, null, {localStorage:storage});

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const effective = hooks.effectiveSettingsForSolve(plan.settings, data);
  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(plan.settings.ui_custom_solve_duration_seconds, 275);
  assert.equal(plan.settings.overall_time_limit_seconds, 275);
  assert.equal(plan.settings.optimization_time_limit_seconds, 275);
  assert.equal(plan.settings.integrated_time_limit, 275);
  assert.equal(plan.settings.backend_deadline_ms, 275000);
  assert.equal(plan.settings.native_global_deadline_ms, 275000);
  assert.equal(plan.settings.progress_estimate_seconds, 275);
  assert.equal(plan.settings.optimization_first_click_quality_time_limit_seconds, 195);
  assert.equal(plan.settings.optimization_first_click_local_lns_time_limit_seconds, 45);
  assert.equal(plan.settings.ui_custom_fresh_continue_quality, true);
  assert.equal(plan.settings.optimization_continue_quality_search, true);
  assert.equal(plan.settings.ui_unified_return_first_complete, false);
  assert.equal(plan.settings.ui_stop_after_first_complete_schedule, false);
  assert.equal(plan.settings.ui_bounded_fresh_accept_quality_debt, true);
  assert.equal(effective.overall_time_limit_seconds, 275);
  assert.equal(effective.optimization_time_limit_seconds, 275);
  assert.equal(effective.integrated_time_limit, 275);
  assert.equal(effective.backend_deadline_ms, 275000);
  assert.equal(effective.native_global_deadline_ms, 275000);
  assert.equal(hooks.estimateSolveSeconds(effective, data), 275);
  assert.equal(hooks.progressBudgetSeconds(effective, 275), 275);
  assert.equal(effective.require_complete_schedule, true);
  assert.equal(effective.allow_quality_debt, true);

  assert.equal(hooks.writeCustomSolveDurationSeconds(""), 0);
  assert.equal(storage.getItem("TKB_SOLVE_DURATION_SECONDS_V2"), null);
  assert.equal(hooks.writeCustomSolveDurationSeconds(1), 10);
  assert.equal(hooks.writeCustomSolveDurationSeconds(999), 999);
  assert.equal(hooks.writeCustomSolveDurationSeconds(9999), 1800);
  storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", "not-a-number");
  assert.equal(hooks.readCustomSolveDurationSeconds(), 0);
  assert.equal(storage.getItem("TKB_SOLVE_DURATION_SECONDS_V2"), null);
});

test("a 180-second first run keeps the remaining budget for quality", () => {
  const storage = memoryStorage();
  storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", "180");
  const data = makeData(2);
  const {hooks} = loadBridge(data, null, {localStorage:storage});

  const plan = hooks.buildAutomaticAutoSortPlan(data);

  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(plan.settings.overall_time_limit_seconds, 180);
  assert.equal(plan.settings.optimization_first_click_feasibility_time_limit_seconds, 70);
  assert.equal(plan.settings.optimization_first_click_quality_time_limit_seconds, 100);
  assert.equal(plan.settings.ui_custom_fresh_continue_quality, true);
  assert.equal(plan.settings.optimization_continue_quality_search, true);
  assert.equal(plan.settings.ui_stop_after_first_complete_schedule, false);
});

test("custom seconds duration overrides every refinement round without weakening incumbent guards", () => {
  const storage = memoryStorage();
  storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", "310");
  const data = makeData(2);
  data.tkb = {L1:{thu2:{sang:[{mon:"Toán"}, {mon:"Toán"}, "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
    validation:{hard_ok:true},
    solver:{runtime_settings:{optimization_refinement_round:2}}
  };
  const {window, hooks} = loadBridge(data, null, {localStorage:storage});
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const effective = hooks.effectiveSettingsForSolve(plan.settings, data);
  assert.equal(plan.kind, "refine_complete");
  assert.equal(plan.settings.optimization_refinement_round, 3);
  assert.equal(plan.settings.ui_unified_refine_ceiling_seconds, 310);
  assert.equal(plan.settings.ui_incremental_progress_estimate_seconds, 310);
  assert.equal(effective.overall_time_limit_seconds, 310);
  assert.equal(effective.optimization_time_limit_seconds, 310);
  assert.equal(effective.progress_estimate_seconds, 310);
  assert.equal(effective.preserve_existing_tkb, true);
  assert.equal(effective.preserve_existing_min_ratio, 1);
  assert.equal(effective.ui_keep_better_existing_on_resort, true);
  assert.equal(effective.require_complete_schedule, true);
  assert.equal(effective.optimization_continue_quality_search, true);
  assert.equal(effective.ui_stop_refinement_when_good_enough, false);
  assert.equal(effective.optimization_stop_on_stagnation, true);
  assert.equal(effective.optimization_benders_accept_stagnant_iterations, 2);
});

test("a sub-30-second custom duration is promoted and persisted for a fresh or incomplete timetable", async () => {
  for(const [requested, scheduled] of [[10, 0], [20, 1]]){
    const storage = memoryStorage();
    storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", String(requested));
    const data = makeData(2);
    if(scheduled > 0){
      data.tkb = {L1:{thu2:{sang:[data.mon[0].ten, "", "", "", ""], chieu:["", "", "", "", ""]}}};
    }
    let posted = null;
    const fetchImpl = async (url, options = {}) => {
      const requestUrl = String(url);
      if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
      if(requestUrl.endsWith("/api/solve-data")){
        posted = JSON.parse(options.body);
        return jsonResponse({ok:false, kind:"duration_probe", error:"duration probe"}, 422);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const {window, hooks} = loadBridge(data, fetchImpl, {localStorage:storage});
    window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:scheduled, chuaXepTiet:2 - scheduled});
    const plan = hooks.buildAutomaticAutoSortPlan(data);

    assert.equal(plan.kind, "fresh_complete_first");
    assert.equal(plan.settings.ui_requested_custom_solve_duration_seconds, requested);
    assert.equal(plan.settings.ui_fresh_solve_duration_floor_applied, true);
    assert.equal(storage.getItem("TKB_SOLVE_DURATION_SECONDS_V2"), "30");
    await assert.rejects(hooks.postSolve(plan.settings, data));
    assert.ok(posted);
    assert.equal(posted.settings.ui_custom_solve_duration_seconds, 30);
    assert.equal(posted.settings.overall_time_limit_seconds, 30);
    assert.equal(posted.settings.optimization_time_limit_seconds, 30);
    assert.equal(posted.settings.integrated_time_limit, 30);
    assert.equal(posted.settings.backend_deadline_ms, 30000);
    assert.equal(posted.settings.native_global_deadline_ms, 30000);
    assert.equal(posted.settings.progress_estimate_seconds, 30);
    assert.equal(posted.settings.require_complete_schedule, true);
    assert.equal(posted.settings.ui_bounded_fresh_accept_quality_debt, true);
    assert.equal(posted.settings.max_one_period_sessions, "off");
    assert.equal(posted.settings.strict_one_period_sessions_cap, false);
    assert.equal(posted.settings.enforce_max_one_period_sessions, false);
    assert.equal(posted.settings.period_max_teacher_gap, "off");
    assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG.backendDeadlineMs, 30000);
  }
});

test("short first-click deadline and Benders failures are mapped to friendly guidance", () => {
  const incomplete = makeData(2);
  const incompleteBridge = loadBridge(incomplete);
  const deadlineError = new Error("Global solver deadline exhausted before first-click feasibility phase");
  deadlineError.kind = "simple_solver_failed";
  deadlineError.payload = {
    kind:"simple_solver_failed",
    error:"Global solver deadline exhausted before first-click feasibility phase"
  };
  const deadlineFriendly = incompleteBridge.hooks.friendlySolveError(deadlineError);
  assert.equal(deadlineFriendly.title, "Th\u1eddi gian s\u1eafp x\u1ebfp qu\u00e1 ng\u1eafn");
  assert.equal(deadlineFriendly.level, "warning");
  assert.match(deadlineFriendly.message, /30 gi\u00e2y/u);
  assert.doesNotMatch(`${deadlineFriendly.title}: ${deadlineFriendly.message}`, /Global solver deadline|first-click/i);

  const firstClickError = new Error(
    "First-click feasibility phase did not produce a complete hard-valid timetable before deadline"
  );
  firstClickError.kind = "simple_solver_failed";
  firstClickError.payload = {
    kind:"simple_solver_failed",
    error:firstClickError.message
  };
  const firstClickFriendly = incompleteBridge.hooks.friendlySolveError(firstClickError);
  assert.equal(firstClickFriendly.title, "Ch\u01b0a t\u00ecm \u0111\u01b0\u1ee3c l\u1ecbch \u0111\u1ee7");
  assert.equal(firstClickFriendly.level, "warning");
  assert.doesNotMatch(
    `${firstClickFriendly.title}: ${firstClickFriendly.message}`,
    /First-click feasibility|hard-valid|deadline/i
  );

  const bendersError = new Error('Benders teacher-session cap search failed: {"cap":522,"history":[]}');
  bendersError.kind = "simple_solver_failed";
  bendersError.payload = {
    kind:"simple_solver_failed",
    error:'Benders teacher-session cap search failed: {"cap":522,"history":[]}'
  };
  const incompleteFriendly = incompleteBridge.hooks.friendlySolveError(bendersError);
  assert.equal(incompleteFriendly.title, "Ch\u01b0a t\u00ecm \u0111\u01b0\u1ee3c l\u1ecbch ph\u00f9 h\u1ee3p");
  assert.equal(incompleteFriendly.level, "warning");
  assert.match(incompleteFriendly.message, /30 gi\u00e2y/u);
  assert.doesNotMatch(`${incompleteFriendly.title}: ${incompleteFriendly.message}`, /Benders|"cap"|history/i);

  const complete = makeData(2);
  complete.tkb = {L1:{thu2:{sang:[complete.mon[0].ten, complete.mon[0].ten, "", "", ""], chieu:["", "", "", "", ""]}}};
  complete.tkbSolverResult = {
    metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
    validation:{hard_ok:true}
  };
  const completeBridge = loadBridge(complete);
  completeBridge.window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});
  const completeFriendly = completeBridge.hooks.friendlySolveError(bendersError);
  assert.equal(completeFriendly.title, "Ch\u01b0a c\u1ea3i thi\u1ec7n th\u00eam");
  assert.equal(completeFriendly.message, "\u0110\u00e3 x\u1ebfp xong!");
  assert.equal(completeFriendly.statusLevel, "warning");
  assert.doesNotMatch(`${completeFriendly.title}: ${completeFriendly.message}`, /Benders|"cap"|history/i);
});

test("automatic solver ignores legacy Fast preference and starts quality complete-first", () => {
  const data = makeData(2);
  const {window, hooks} = loadBridge(data);
  window.localStorage.setItem("TKB_SOLVER_PRESET", "fast");

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(window.TKBRustAPI.readSolverPreset(), "balanced");
  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(plan.settings.ui_solver_preset, "balanced");
  assert.equal(plan.settings.auto_sort_mode, "teacher_session_opt");
  assert.equal(plan.settings.optimization_time_limit_seconds, 60);
  assert.equal(plan.settings.ui_unified_reference_watchdog_reserve_ms, 5000);
  assert.equal(plan.settings.ui_client_timeout_reserve_ms, 10000);
  assert.equal(plan.settings.ui_allow_quality_after_single_pass, false);
  assert.equal(plan.settings.target_gap1_sessions, 0);
  assert.equal(plan.settings.optimization_accept_gap1_sessions, 0);
  assert.equal(plan.settings.quality_priority_order, "one_period_gap2_teacher_sessions_gap1");
  assert.equal(plan.settings.optimization_benders_disable_session_early_stop, true);
});

test("large unified first click uses one bounded 60-second first-good search", () => {
  const data = makeData(1500);
  const {hooks} = loadBridge(data);
  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const effective = hooks.effectiveSettingsForSolve(plan.settings, data);

  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(effective.ui_unified_initial_fast_stage, true);
  assert.equal(effective.ui_unified_initial_ceiling_seconds, 60);
  assert.equal(effective.overall_time_limit_seconds, 60);
  assert.equal(effective.integrated_time_limit, 60);
  assert.equal(effective.optimization_time_limit_seconds, 60);
  assert.equal(effective.backend_deadline_ms, 60000);
  assert.equal(effective.native_global_deadline_ms, 60000);
  assert.equal(effective.optimization_first_click_feasibility_time_limit_seconds, 60);
  assert.equal(effective.optimization_first_click_quality_time_limit_seconds, 35);
  assert.equal(effective.optimization_first_click_quality_minimum_seconds, 12);
  assert.equal(effective.optimization_first_click_local_lns_time_limit_seconds, 30);
  assert.equal(effective.target_gap1_sessions, 50);
  assert.equal(effective.optimization_first_click_quality_cap_headroom, 16);
  assert.equal(effective.optimization_first_click_target_probe_step, 2);
  assert.equal(effective.optimization_first_click_target_probe_time_limit_seconds, 30);
  assert.equal(effective.optimization_first_click_target_probe_convergence_ceiling_seconds, 60);
  assert.equal(effective.optimization_first_click_target_probe_enabled, false);
  assert.equal(effective.optimization_unbounded_quality_search, false);
  assert.equal(effective.ui_bounded_fresh_accept_quality_debt, true);
  assert.equal(effective.allow_quality_debt, true);
  assert.equal(effective.max_one_period_sessions, "off");
  assert.equal(effective.strict_one_period_sessions_cap, false);
  assert.equal(effective.enforce_max_one_period_sessions, false);
  assert.equal(effective.period_max_teacher_gap, "off");
  assert.equal(effective.optimization_stop_on_stagnation, true);
  assert.equal(effective.optimization_benders_accept_stagnant_iterations, undefined);
  assert.equal(effective.optimization_existing_local_quality_lns_passes, 16);
  assert.equal(effective.optimization_existing_local_quality_lns_pass_seconds, 3);
  assert.equal(effective.optimization_existing_local_quality_lns_stagnant_passes, 5);
  assert.equal(effective.optimization_existing_local_quality_lns_max_classes, 12);
  assert.equal(effective.optimization_existing_local_quality_lns_max_lessons, 420);
  assert.equal(effective.ui_no_hint_randomized_solve, true);
  assert.equal(effective.fresh_randomize, true);
  assert.equal(effective.randomize_search, true);
  assert.ok(Number.isInteger(effective.random_seed));
  assert.ok(effective.random_seed > 0);
  assert.equal(effective.quality_variant_seed, effective.random_seed);
  assert.equal(effective.ui_unified_reference_watchdog_reserve_ms, 5000);
  assert.equal(effective.ui_client_timeout_reserve_ms, 10000);
});

test("ten no-hint fresh plans use ten distinct positive search trajectories", () => {
  const data = makeData(1500);
  class FixedDate extends Date {
    static now(){ return 1_700_000_000_000; }
  }
  const fixedMath = Object.create(Math);
  fixedMath.random = () => 0;
  const {hooks} = loadBridge(data, null, {Date:FixedDate, Math:fixedMath});
  const seeds = [];

  for(let run = 0; run < 10; run += 1){
    const plan = hooks.buildAutomaticAutoSortPlan(data);
    assert.equal(plan.kind, "fresh_complete_first");
    assert.equal(plan.settings.ui_no_hint_fresh_solve, true);
    assert.equal(plan.settings.allow_solver_warm_start, false);
    assert.equal(plan.settings.disable_solver_hints, true);
    assert.equal(plan.settings.quality_variant_seed, plan.settings.random_seed);
    assert.ok(Number.isInteger(plan.settings.random_seed));
    assert.ok(plan.settings.random_seed > 0);
    seeds.push(plan.settings.random_seed);
  }

  assert.equal(new Set(seeds).size, 10);
});

test("automatic duration keeps 60 seconds fresh and 180 seconds for refinement", () => {
  const data = makeData(1500);
  const {hooks} = loadBridge(data);

  assert.equal(hooks.initialAutomaticSolverCeilingSeconds(1500, data), 60);
  assert.equal(hooks.incrementalRefineCeilingSeconds(1500, data, 1), 180);
  assert.equal(hooks.incrementalRefineCeilingSeconds(1500, data, 2), 180);
  assert.equal(hooks.incrementalRefineCeilingSeconds(1500, data, 3), 180);
  assert.equal(hooks.incrementalRefineCeilingSeconds(1500, data, 8), 180);
});

test("automatic retries keep click progress monotonic while following the 60-180-180 second budget", () => {
  const data = makeData(1500);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker({
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    progress_estimate_seconds:60,
    overall_time_limit_seconds:60,
    backend_deadline_ms:60_000
  }, data);
  clock.advance(1_000);
  hooks.tickEstimatedProgress();
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.runIndex, 1);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.budgetSeconds, 60);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "1 giây");
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.phase, "preparing");

  clock.advance(29_000);
  hooks.tickEstimatedProgress();
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent > 4);
  const firstRunPercent = window.__TKB_RUST_PROGRESS_STATE.percent;

  hooks.restartProgressForRetry({
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    robust_retry:true,
    progress_estimate_seconds:180,
    overall_time_limit_seconds:180,
    backend_deadline_ms:180_000
  }, data);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.runIndex, 2);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.percent, firstRunPercent);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.budgetSeconds, 180);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "30 giây");

  clock.advance(75_000);
  hooks.tickEstimatedProgress();
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent > 4);
  const secondRunPercent = window.__TKB_RUST_PROGRESS_STATE.percent;
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "1:45");

  hooks.restartProgressForRetry({
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    complete_schedule_seed_retry:true,
    progress_estimate_seconds:180,
    overall_time_limit_seconds:180,
    backend_deadline_ms:180_000
  }, data);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.runIndex, 3);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.percent, secondRunPercent);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.budgetSeconds, 180);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "1:45");
});

test("a blank first Play owns one adaptive pass without hidden retries", async () => {
  const data = makeData(2);
  let solvePosts = 0;
  const postedSettings = [];
  const incompletePayload = {
    ok:true,
    metrics:{
      scheduled_periods:1,
      expected_periods:2,
      unassigned_periods:1,
      hard_ok:true,
      core_hard_ok:true,
      best_effort:true
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:60}},
    lessons:[],
    unassignedLessons:[{classId:"L1", subject:"Toán", count:1}],
    warnings:[]
  };
  const completePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[
      {classId:"L1", className:"10A1", subject:"Toán", teacher:"GV01", day:2, session:"AM", period:1},
      {classId:"L1", className:"10A1", subject:"Toán", teacher:"GV01", day:2, session:"AM", period:2}
    ],
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:0,
      teacher_gap2_sessions:0,
      teacher_sessions:1,
      gap_distribution:{"0":1}
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:45}},
    unassignedLessons:[],
    warnings:[]
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      postedSettings.push(JSON.parse(options.body).settings);
      return jsonResponse(solvePosts === 1 ? incompletePayload : completePayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  const plan = hooks.buildAutomaticAutoSortPlan(data);

  assert.equal(plan.settings.ui_disable_initial_fast_draft, true);
  assert.equal(plan.settings.ui_allow_incomplete_retry_after_single_pass, false);
  assert.equal(plan.settings.ui_stop_after_first_complete_schedule, false);
  assert.equal(plan.settings.optimization_first_click_continue_local_after_complete, true);
  assert.equal(plan.settings.ui_disable_automatic_retry, true);
  assert.equal(plan.settings.complete_schedule_seed_retry_max_runs, 0);
  assert.equal(plan.settings.overall_time_limit_seconds, 60);
  assert.equal(plan.settings.backend_deadline_ms, 60000);
  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});
  assert.equal(result, null);
  assert.equal(solvePosts, 1);
  assert.equal(postedSettings[0].overall_time_limit_seconds, 60);
});

test("an explicit duration remains one exact solver budget when no complete schedule is found", async () => {
  const storage = memoryStorage();
  storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", "90");
  const data = makeData(2);
  let solvePosts = 0;
  const postedSettings = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      postedSettings.push(JSON.parse(options.body).settings);
      return jsonResponse({
        ok:true,
        metrics:{scheduled_periods:1, expected_periods:2, unassigned_periods:1, hard_ok:true, best_effort:true},
        validation:{hard_ok:true, violations:[]},
        solver:{runtime_settings:{elapsed_seconds:90}},
        lessons:[],
        unassignedLessons:[{classId:"L1", subject:"Toán", count:1}],
        warnings:[]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, {localStorage:storage});
  const plan = hooks.buildAutomaticAutoSortPlan(data);

  assert.equal(plan.settings.ui_allow_incomplete_retry_after_single_pass, false);
  assert.equal(plan.settings.ui_stop_after_first_complete_schedule, false);
  assert.equal(plan.settings.optimization_first_click_continue_local_after_complete, true);
  assert.equal(plan.settings.overall_time_limit_seconds, 90);
  assert.equal(await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true}), null);
  assert.equal(solvePosts, 1);
  assert.equal(postedSettings[0].overall_time_limit_seconds, 90);
});

test("blank first-solution search does not retry automatically after a deadline error", async () => {
  const data = makeData(2);
  let solvePosts = 0;
  const postedSettings = [];
  const progressSnapshots = [];
  let activeWindow = null;
  const deadlinePayload = {
    ok:false,
    kind:"no_complete_schedule_before_deadline",
    error:"deadline before complete schedule",
    metrics:{scheduled_periods:0, expected_periods:2, unassigned_periods:2, hard_ok:false},
    validation:{hard_ok:false, violations:[]},
    solver:{runtime_settings:{deadline_hit:true}},
    lessons:[],
    unassignedLessons:[{classId:"L1", subject:"Toán", count:2}]
  };
  const completePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[
      {classId:"L1", className:"10A1", subject:"Toán", teacher:"GV01", day:2, session:"AM", period:1},
      {classId:"L1", className:"10A1", subject:"Toán", teacher:"GV01", day:2, session:"AM", period:2}
    ],
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:0,
      teacher_gap2_sessions:0,
      teacher_sessions:1,
      gap_distribution:{"0":1}
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:40}},
    unassignedLessons:[],
    warnings:[]
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      postedSettings.push(JSON.parse(options.body).settings);
      progressSnapshots.push(Object.assign({}, activeWindow?.__TKB_RUST_PROGRESS_STATE || {}));
      return solvePosts <= 2 ? jsonResponse(deadlinePayload, 422) : jsonResponse(completePayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, fetchImpl, {
    console:quietConsole,
    Date:clock.Date,
    setTimeout:clock.setTimeout,
    clearTimeout:clock.clearTimeout
  });
  activeWindow = window;
  const plan = hooks.buildAutomaticAutoSortPlan(data);

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});
  assert.equal(result, null);
  assert.equal(solvePosts, 1);
  assert.deepEqual(
    postedSettings.map(settings => settings.overall_time_limit_seconds),
    [60]
  );
  assert.deepEqual(
    progressSnapshots.map(state => [state.runIndex, state.percent, state.budgetSeconds]),
    [[1, 4, 60]]
  );
  assert.deepEqual(
    progressSnapshots.map(state => state.label),
    ["0 giây"]
  );
  assert.equal(data.tkbManualFreshRetryBudget.nextSeconds, 65);
  const nextManualPlan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(nextManualPlan.settings.backend_deadline_ms, 65_000);
  assert.equal(nextManualPlan.settings.ui_manual_fresh_retry_seconds, 65);
  assert.equal(solvePosts, 1, "a failed solve must never start another job automatically");
});

test("a complete manual retry uses the remembered 65-second fresh cap", async () => {
  const data = makeData(2);
  let solvePosts = 0;
  let postedDeadline = 0;
  const completePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[
      {classId:"L1", className:"10A1", subject:"ToÃ¡n", teacher:"GV01", day:2, session:"AM", period:1},
      {classId:"L1", className:"10A1", subject:"ToÃ¡n", teacher:"GV01", day:2, session:"AM", period:2}
    ],
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:0,
      teacher_gap2_sessions:0,
      teacher_sessions:1,
      gap_distribution:{"0":1}
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:40}},
    unassignedLessons:[],
    warnings:[]
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      postedDeadline = JSON.parse(options.body).settings.backend_deadline_ms;
      return jsonResponse(completePayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const successClock = createFakeClock();
  const {window, hooks} = loadBridge(data, fetchImpl, {
    console:quietConsole,
    Date:successClock.Date,
    setTimeout:successClock.setTimeout,
    clearTimeout:successClock.clearTimeout
  });
  const first = hooks.buildAutomaticAutoSortPlan(data);
  const failure = Object.assign(new Error("deadline before complete schedule"), {
    kind:"no_complete_schedule_before_deadline"
  });
  hooks.rememberManualFreshRetryFailure(data, first.settings, failure);
  const retryPlan = hooks.buildAutomaticAutoSortPlan(data);

  const result = await window.TKBRustAPI.solve({
    ask:false,
    settings:retryPlan.settings,
    singlePass:true
  });

  assert.ok(result);
  assert.equal(solvePosts, 1);
  assert.equal(postedDeadline, 65_000);
  assert.equal(data.tkbManualFreshRetryBudget, undefined);
  assert.equal(hooks.manualFreshRetryBudgetSeconds(data), 60);
});

test("an unchanged refinement ends cleanly without blocking a later Play", () => {
  const body = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"),
    BRIDGE_SOURCE.indexOf("const autoSortButton", BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"))
  );
  assert.match(body, /automaticPlan\.kind\s*===\s*"refine_complete"[\s\S]*refinementStatisticsImproved\(/);
  assert.match(body, /const refinementUnchanged\s*=\s*automaticPlan\.kind\s*===\s*"refine_complete"[\s\S]*!statisticsImproved/);
  assert.doesNotMatch(body, /refinementRetry|skipStartConfirm|__tkbInternalOptimizeRetry/);
  assert.match(body, /rememberOptimizationPlateau\(getData\(\),\s*plateauBeforeSolve,\s*false\)/);
  assert.match(body, /const plateauMessage\s*=\s*noBetterScheduleStatus\(/);
  assert.match(body, /finishProgress\("100%",\s*"ok"\)/);
  assert.match(body, /setStatus\(plateauMessage,\s*"ok"\)/);
});

test("every complete terminal path uses the concise completion notice", () => {
  const source = BRIDGE_SOURCE;
  const firstCompletionCheck = needle => source.indexOf(
    needle,
    source.indexOf("function finishLocalUnassignedRepairPayload")
  );
  const successPath = source.slice(
    source.indexOf("function finishLocalUnassignedRepairPayload"),
    firstCompletionCheck("completion = payloadCompletion(payload);")
  );
  assert.match(successPath, /window\.__TKB_SOLVER_LAST_COMPLETION_MESSAGE\s*=\s*SOLVE_COMPLETE_MESSAGE/);
  assert.match(successPath, /setStatus\(SOLVE_COMPLETE_MESSAGE,\s*"ok"\)/);

  const incumbentGuard = source.slice(
    source.indexOf("shouldKeepIncumbentForTeacherQuality(payload, incumbentPayload, incumbentQualityGuard)"),
    source.indexOf(
      "completion = payloadCompletion(payload);",
      source.indexOf("shouldKeepIncumbentForTeacherQuality(payload, incumbentPayload, incumbentQualityGuard)")
    )
  );
  assert.match(incumbentGuard, /const message\s*=\s*SOLVE_COMPLETE_MESSAGE/);
  assert.match(incumbentGuard, /setStatus\(message,\s*"ok"\)/);
  assert.doesNotMatch(incumbentGuard, /NO_BETTER_SCHEDULE_MESSAGE/);
});

test("refinement replacement is decided by ordered quality statistics", () => {
  const data = makeData(10);
  const {hooks} = loadBridge(data);
  const payload = (teacherSessions, gap1, onePeriod = 0, gap2 = 0) => ({
    metrics:{
      scheduled_periods:10,
      expected_periods:10,
      unassigned_periods:0,
      hard_ok:true,
      one_period_teacher_sessions:onePeriod,
      teacher_sessions:teacherSessions,
      gap_distribution:{"0":Math.max(0, teacherSessions - gap1 - gap2), "1":gap1, "2":gap2}
    },
    validation:{hard_ok:true}
  });
  const incumbent = payload(7, 2);

  assert.equal(hooks.refinementStatisticsImproved(payload(6, 3), incumbent, true), false);
  assert.equal(hooks.refinementStatisticsImproved(payload(6, 2), incumbent, true), true);
  assert.equal(hooks.refinementStatisticsImproved(payload(7, 2), incumbent, true), false);
  assert.equal(hooks.refinementStatisticsImproved(payload(8, 0), incumbent, true), false);
  assert.equal(hooks.refinementStatisticsImproved(payload(7, 1), incumbent, true), true);
});

test("a recorded no-improvement slice never blocks blank-duration sorting", () => {
  const storage = memoryStorage();
  const data = makeData(1);
  data.tkb = {L1:{thu2:{sang:[data.mon[0].ten, "", "", "", ""], chieu:["", "", "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{
      scheduled_periods:1,
      expected_periods:1,
      unassigned_periods:0,
      hard_ok:true,
      teacher_sessions:1,
      one_period_teacher_sessions:1,
      gap_distribution:{"0":1}
    },
    validation:{hard_ok:true}
  };
  const {window, hooks} = loadBridge(data, null, {localStorage:storage});
  const locked = hooks.rememberOptimizationPlateau(data, null, true);
  assert.equal(locked.locked, true);
  assert.equal(locked.noImprovementSlices, 1);
  assert.equal(hooks.optimizationPlateauState(data).locked, true);
  const automaticUnlock = hooks.syncOptimizationLockState();
  assert.equal(automaticUnlock.locked, false);
  assert.equal(automaticUnlock.rerunAllowed, true);
  const automaticPlan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(automaticPlan.settings.overall_time_limit_seconds, 180);
  assert.equal(automaticPlan.settings.backend_deadline_ms, 180000);

  assert.equal(hooks.writeCustomSolveDurationSeconds(125), 125);
  const customUnlock = hooks.syncOptimizationLockState();
  assert.equal(customUnlock.locked, false);
  assert.equal(customUnlock.customDurationOverride, true);
  const customPlan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(customPlan.settings.overall_time_limit_seconds, 125);
  assert.equal(customPlan.settings.backend_deadline_ms, 125000);

  data.pccmGioihanMatrix["L1|Toán"] = 2;
  assert.equal(hooks.optimizationPlateauState(data), null, "changing solver input unlocks optimization");
});

test("complete refinement request carries incumbent lessons while other requests stay compact", () => {
  const data = makeData(2);
  const subject = data.mon[0].ten;
  data.tkb = {L1:{thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}}};
  const lessons = [
    {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:1},
    {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:2}
  ];
  data.tkbSolverResult = {
    lessons,
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      gap_sessions:[{teacher:"GV01", gap:1}]
    },
    validation:{hard_ok:true},
    solver:{runtime_settings:{optimization_refinement_round:2}},
    unassignedLessons:[]
  };
  const {hooks} = loadBridge(data);

  const refine = hooks.dataForSolverRequest(data, {
    allow_solver_warm_start:true,
    preserve_existing_tkb:true,
    ui_unified_solve_kind:"refine_complete",
    ui_use_existing_complete_incumbent:true,
    ui_existing_incumbent_revalidated:true
  });
  assert.equal(refine.tkbSolverResult.lessons.length, 2);
  assert.equal(JSON.stringify(refine.tkbSolverResult.lessons), JSON.stringify(lessons));
  assert.equal(refine.tkbSolverResult.metrics.gap_sessions, undefined);

  delete data.tkbSolverResult.lessons;
  const restoredRefine = hooks.dataForSolverRequest(data, {
    allow_solver_warm_start:true,
    preserve_existing_tkb:true,
    ui_unified_solve_kind:"refine_complete",
    ui_use_existing_complete_incumbent:true,
    ui_existing_incumbent_revalidated:true
  });
  assert.equal(restoredRefine.tkbSolverResult.lessons.length, 2);
  assert.equal(restoredRefine.tkbSolverResult.lessons[0].classId, "L1");

  const genericWarm = hooks.dataForSolverRequest(data, {allow_solver_warm_start:true});
  assert.ok(genericWarm.tkbSolverResult);
  assert.equal(genericWarm.tkbSolverResult.lessons, undefined);

  const fresh = hooks.dataForSolverRequest(data, {
    allow_solver_warm_start:false,
    ui_unified_solve_kind:"fresh_complete_first"
  });
  assert.equal(fresh.tkbSolverResult, undefined);
});

test("a persisted custom duration unlocks an optimized timetable immediately after reload", () => {
  const storage = memoryStorage();
  storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", "125");
  const data = makeData(1);
  data.tkb = {L1:{thu2:{sang:[data.mon[0].ten, "", "", "", ""], chieu:["", "", "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{scheduled_periods:1, expected_periods:1, unassigned_periods:0, hard_ok:true},
    validation:{hard_ok:true},
    solver:{runtime_settings:{}}
  };
  const fingerprint = loadBridge(data).hooks.durableScheduleFingerprint(data);
  data.tkbOptimizationPlateau = {
    fingerprint,
    noImprovementSlices:1,
    locked:true,
    updatedAt:new Date().toISOString()
  };
  const progress = createProgressDocument();
  const {hooks} = loadBridge(data, null, {
    localStorage:storage,
    document:progress.document
  });

  assert.equal(progress.duration.value, "125");
  assert.equal(progress.duration.dataset.durationMode, "custom");
  assert.equal(progress.button.disabled, false);
  assert.equal(hooks.syncOptimizationLockState().customDurationOverride, true);
});

test("fixed-only physical schedule overrides stale complete solver and UI counters", async () => {
  const data = makeData(1566);
  const subject = data.mon[0].ten;
  data.tkb = {L1:{thu2:{sang:[{mon:subject, fixed:true}, "", "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{scheduled_periods:1566, expected_periods:1566, unassigned_periods:0, hard_ok:true},
    solver:{runtime_settings:{auto_sort_mode:"teacher_session_opt"}}
  };
  let posted = null;
  let resultPolls = 0;
  const diagnostics = {reason:"fixed_only_stale_incumbent_regression", physicalScheduled:1};
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      posted = JSON.parse(options.body);
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId:posted.settings.ui_solve_run_id,
        retryAfterMs:250
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      return jsonResponse({
        ok:false,
        kind:"simple_solver_failed",
        error:"structured terminal solver failure",
        diagnostics
      }, 500);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const {window, hooks} = loadBridge(data, fetchImpl, {console:quietConsole});
  window.calcSchoolTKBStats = () => ({soTiet:1566, daXepTiet:1531, chuaXepTiet:35});

  const stats = hooks.cheapSchoolCompletionStats(data);
  const repair = hooks.partialExistingRepairState(data, {repair_fill_first_max_missing:64, preserve_existing_min_ratio:0.8});
  const plan = hooks.buildAutomaticAutoSortPlan(data);

  assert.equal(stats.scheduled, 1);
  assert.equal(stats.unassigned, 1565);
  assert.equal(repair.eligible, false);
  assert.equal(plan.kind, "fresh_complete_first");
  await assert.rejects(
    hooks.postSolve(plan.settings, data),
    err => err?.kind === "simple_solver_failed" && err?.payload?.diagnostics?.reason === diagnostics.reason
  );
  assert.equal(resultPolls, 1, "a structured terminal 500 must not be polled as a transient gateway error");
  assert.equal(posted.settings.ui_unified_solve_kind, "fresh_complete_first");
  assert.equal(posted.settings.ui_unified_partial_repair, undefined);
  assert.equal(posted.settings.preserve_existing_tkb, false);
  assert.equal(posted.settings.preserve_fixed_lessons_only, true);
  assert.equal(posted.settings.existing_fixed_scheduled_periods, 1);
  assert.equal(posted.data.tkbSolverResult, undefined, "fresh request must strip the stale complete incumbent");
  assert.equal(posted.data.__tkbRequestFixedScheduleOnly, true);
  assert.deepEqual(window.__TKB_SOLVER_LAST_ERROR_PAYLOAD.diagnostics, diagnostics);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("incomplete physical incumbent is not described as a complete old timetable", async () => {
  const data = makeData(1566);
  const subject = data.mon[0].ten;
  data.tkb = {L1:{thu2:{sang:[{mon:subject, fixed:true}, "", "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{scheduled_periods:1566, expected_periods:1566, unassigned_periods:0, hard_ok:true}
  };
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      return jsonResponse({
        ok:false,
        kind:"no_complete_schedule_before_deadline",
        error:"deadline",
        lessons:[],
        metrics:{scheduled_periods:0, expected_periods:1566, unassigned_periods:1566, hard_ok:false},
        solver:{runtime_settings:{deadline_hit:true}}
      }, 422);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const {window, hooks} = loadBridge(data, fetchImpl, {console:quietConsole});
  window.calcSchoolTKBStats = () => ({soTiet:1566, daXepTiet:1531, chuaXepTiet:35});
  const plan = hooks.buildAutomaticAutoSortPlan(data);

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.equal(result, null);
  assert.equal(hooks.countScheduledLessons(data), 1);
  assert.match(window.__TKB_SOLVER_LAST_ERROR, /1 tiết hiện có/);
  assert.doesNotMatch(window.__TKB_SOLVER_LAST_ERROR, /giữ lịch cũ/i);
});

test("automatic solver sends a small residual through full quality instead of fast-only repair", () => {
  const data = makeData(2);
  data.tkb = {L1:{thu2:{sang:[{mon:"ToÃ¡n"}, "", "", "", ""]}}};
  const {window, hooks} = loadBridge(data);
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:1, chuaXepTiet:1});

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const effective = hooks.effectiveSettingsForSolve(plan.settings, data);
  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(effective.auto_sort_mode, "teacher_session_opt");
  assert.equal(effective.ui_default_fresh_sort, true);
  assert.notEqual(effective.preserve_existing_tkb, true);
  assert.equal(effective.optimize_existing_schedule, false);
  assert.equal(effective.overall_time_limit_seconds, 60);
  assert.equal(effective.backend_deadline_ms, 60000);
  assert.equal(effective.ui_allow_short_backend_deadline, true);
  assert.notEqual(effective.ui_unified_initial_fast_stage, true);
  assert.equal(effective.ui_bounded_fresh_accept_quality_debt, true);
  assert.equal(effective.max_one_period_sessions, "off");
  assert.equal(effective.strict_one_period_sessions_cap, false);
  assert.equal(effective.allow_quality_debt, true);
  assert.equal(effective.period_max_teacher_gap, "off");
  assert.equal(effective.ui_unified_reference_watchdog_reserve_ms, 5000);
  assert.equal(effective.ui_client_timeout_reserve_ms, 10000);
});

test("automatic solver refines a demand-valid complete timetable as a soft incumbent", () => {
  const data = makeData(2);
  data.tkb = {L1:{thu2:{sang:[{mon:"ToÃ¡n"}, {mon:"ToÃ¡n", fixed:true}, "", "", ""]}}};
  const {window, hooks} = loadBridge(data);
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const effective = hooks.effectiveSettingsForSolve(plan.settings, data);
  assert.equal(plan.kind, "refine_complete");
  assert.equal(effective.auto_sort_mode, "teacher_session_opt");
  assert.equal(effective.auto_sort_strategy, "continue_teacher_quality_from_incumbent");
  assert.equal(effective.preserve_existing_tkb, true);
  assert.equal(effective.preserve_fixed_lessons_only, true);
  assert.equal(effective.ui_use_existing_complete_incumbent, true);
  assert.equal(effective.ui_existing_incumbent_revalidated, true);
  assert.equal(effective.ui_return_complete_incumbent_on_existing_optimize_failure, true);
  assert.equal(effective.optimization_refinement_round, 1);
  assert.equal(effective.ui_incremental_refine_progress, true);
  assert.equal(effective.optimization_refine_try_lower_session_cap, true);
  assert.equal(effective.optimization_benders_lean_refinement_periods, true);
  assert.equal(effective.quality_priority_order, "one_period_gap2_teacher_sessions_gap1");
  assert.equal(effective.target_gap1_sessions, 0);
  assert.equal(effective.gap1_quality_target_explicit, true);
  assert.equal(effective.ui_unified_refine_ceiling_seconds, 180);
  assert.equal(effective.optimization_time_limit_seconds, 180);
  assert.equal(effective.overall_time_limit_seconds, 180);
  assert.equal(effective.backend_deadline_ms, 180000);
  assert.equal(effective.ui_allow_short_backend_deadline, false);
  assert.equal(effective.progress_estimate_seconds, 30);
  assert.equal(hooks.progressBudgetSeconds(effective, hooks.estimateSolveSeconds(effective, data)), 180);
  assert.equal(effective.ui_unified_reference_watchdog_reserve_ms, 5000);
  assert.equal(effective.ui_client_timeout_reserve_ms, 10000);
  assert.notEqual(effective.ui_no_hint_fresh_solve, true);
  assert.equal(effective.allow_solver_warm_start, true);
  assert.equal(effective.optimization_existing_local_quality_lns_passes, undefined);
  assert.equal(effective.optimization_existing_local_quality_lns_pass_seconds, undefined);
  assert.equal(effective.optimization_existing_local_quality_lns_stagnant_passes, undefined);
  assert.equal(effective.optimization_existing_local_quality_lns_max_classes, undefined);
  assert.equal(effective.optimization_existing_local_quality_lns_max_lessons, undefined);

  data.tkbSolverResult = {
    metrics:{optimization_refinement_round:3},
    solver:{runtime_settings:{optimization_refinement_round:3}}
  };
  const inherited = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(inherited.settings.optimization_refinement_round, 4);
  assert.notEqual(inherited.settings.random_seed, effective.random_seed);
  assert.equal(inherited.settings.quality_variant_seed, inherited.settings.random_seed);
  const timingKey = hooks.solveTimingProfileKey(inherited.settings, data);
  window.localStorage.setItem("TKB_RUST_SOLVE_TIMING_V1", JSON.stringify({
    [timingKey]: {estimateSeconds:20}
  }));
  const learned = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(learned.settings.progress_estimate_seconds, 24);
  assert.equal(
    hooks.progressBudgetSeconds(learned.settings, hooks.estimateSolveSeconds(learned.settings, data)),
    180
  );
});

test("complete refinement gets a new randomized soft-incumbent trajectory", () => {
  const data = makeData(29);
  const subject = data.mon[0].ten;
  const filled = (count) => Array.from({length:5}, (_, index) => index < count ? subject : "");
  data.tkb = {
    L1: {
      thu2:{sang:filled(5), chieu:filled(5)},
      thu3:{sang:filled(5), chieu:filled(5)},
      thu4:{sang:filled(5), chieu:filled(4)},
      thu5:{sang:[], chieu:[]}
    }
  };
  data.tkbSolverResult = {
    metrics:{scheduled_periods:29, expected_periods:29, unassigned_periods:0, hard_ok:true},
    validation:{hard_ok:true},
    solver:{runtime_settings:{}}
  };
  const {window, hooks} = loadBridge(data);
  window.calcSchoolTKBStats = () => ({soTiet:29, daXepTiet:29, chuaXepTiet:0});

  const first = hooks.buildAutomaticAutoSortPlan(data);
  const second = hooks.buildAutomaticAutoSortPlan(data);
  const effective = hooks.effectiveSettingsForSolve(first.settings, data);
  assert.equal(first.kind, "refine_complete");
  assert.equal(second.kind, "refine_complete");
  assert.equal(first.settings.preserve_existing_tkb, true);
  assert.equal(first.settings.preserve_existing_min_ratio, 1);
  assert.equal(first.settings.allow_solver_warm_start, true);
  assert.equal(first.settings.fresh_randomize, true);
  assert.equal(first.settings.randomize_search, true);
  assert.ok(first.settings.random_seed > 0);
  assert.equal(first.settings.quality_variant_seed, first.settings.random_seed);
  assert.equal(effective.fresh_randomize, true);
  assert.equal(effective.randomize_search, true);
  assert.equal(effective.quality_variant_seed, effective.random_seed);
  assert.notEqual(second.settings.random_seed, first.settings.random_seed);
});

test("new teacher max-days constraint invalidates a complete incumbent before quality retention", async () => {
  const data = makeData(10);
  const subject = data.mon[0].ten;
  const empty = () => ["", "", "", "", ""];
  const session = (...periods) => {
    const cells = empty();
    periods.forEach(period => { cells[period - 1] = subject; });
    return cells;
  };
  data.tkb = {
    L1:{
      thu2:{sang:session(1, 2), chieu:empty()},
      thu3:{sang:session(1, 2), chieu:empty()},
      thu4:{sang:session(1, 2), chieu:empty()},
      thu5:{sang:session(1, 2, 3, 4), chieu:empty()}
    }
  };
  data.tkbConstraints = {
    teacher:{
      GV01:{maxDaysSessions:{maxDays:3}}
    }
  };
  data.tkbSolverResult = {
    metrics:{
      scheduled_periods:10,
      expected_periods:10,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      teacher_sessions:4,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":4}
    },
    validation:{hard_ok:true},
    solver:{
      runtime_settings:{
        auto_sort_mode:"teacher_session_opt",
        quality_priority_order:"one_period_gap2_teacher_sessions_gap1"
      }
    },
    lessons:[],
    warnings:[],
    unassignedLessons:[]
  };

  const candidateSlots = [
    [2, "AM", 1], [2, "AM", 2],
    [2, "PM", 1], [2, "PM", 2],
    [3, "AM", 1], [3, "AM", 2],
    [3, "PM", 1], [3, "PM", 2],
    [4, "AM", 1], [4, "AM", 2]
  ];
  const candidate = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:candidateSlots.map(([day, sessionName, period]) => ({
      classId:"L1",
      className:"10A1",
      subject,
      teacher:"GV01",
      day,
      session:sessionName,
      period
    })),
    metrics:{
      scheduled_periods:10,
      expected_periods:10,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      teacher_sessions:5,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":5}
    },
    validation:{hard_ok:true},
    solver:{
      runtime_settings:{
        auto_sort_mode:"teacher_session_opt",
        quality_priority_order:"one_period_gap2_teacher_sessions_gap1",
        elapsed_seconds:0.1
      }
    },
    warnings:[],
    unassignedLessons:[]
  };
  let posted = null;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      posted = JSON.parse(options.body);
      return jsonResponse(candidate);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  const activeTeachingDays = () => Object.values(data.tkb?.L1 || {}).filter(day => (
    [...(day?.sang || []), ...(day?.chieu || [])].some(value => value && value !== "OFF")
  )).length;
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    syncDefaultGroups(){},
    validateAll(){
      const days = activeTeachingDays();
      return days > 3
        ? [{kind:"teacher.maxDays", teacherId:"GV01", teacherName:"Giáo viên 01", days, maxDays:3}]
        : [];
    }
  };
  window.calcSchoolTKBStats = () => ({
    soTiet:10,
    daXepTiet:hooks.countScheduledLessons(data),
    chuaXepTiet:Math.max(0, 10 - hooks.countScheduledLessons(data))
  });

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(plan.kind, "fresh_complete_first", "the newly invalid timetable is not a refinement incumbent");
  assert.notEqual(plan.settings.ui_unified_initial_fast_stage, true);
  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.ok(posted, "the changed constraint must trigger a real backend solve");
  assert.ok(result, "the valid replacement must be applied");
  assert.doesNotMatch(
    String(window.__TKB_SOLVER_LAST_COMPLETION_MESSAGE || ""),
    /Thời khóa biểu đã tối ưu, không thể tối ưu thêm/i
  );
  assert.equal(activeTeachingDays(), 3);
  assert.equal(data.tkbSolverResult.metrics.teacher_sessions, 5);
});

test("aggregate teacher max-days violation creates an internal repair without deleting the incumbent first", () => {
  const data = makeData(4);
  const subject = data.mon[0].ten;
  const oneLesson = () => [subject, "", "", "", ""];
  data.tkb = {
    L1:{
      thu2:{sang:oneLesson(), chieu:["", "", "", "", ""]},
      thu3:{sang:oneLesson(), chieu:["", "", "", "", ""]},
      thu4:{sang:oneLesson(), chieu:["", "", "", "", ""]},
      thu5:{sang:oneLesson(), chieu:["", "", "", "", ""]}
    }
  };
  data.tkbConstraints = {
    teacher:{GV01:{maxDaysSessions:{maxDays:3}}}
  };
  const {window, hooks} = loadBridge(data);
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){
      return [{kind:"teacher.maxDays", teacherId:"GV01", days:4, maxDays:3}];
    }
  };
  const activeTeachingDays = () => Object.values(data.tkb.L1).filter(day => (
    [...day.sang, ...day.chieu].some(value => value && value !== "OFF")
  )).length;

  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 4, 0, 1);
  assert.equal(plan.kind, "repair_constraints");
  assert.equal(activeTeachingDays(), 4);
  assert.equal(hooks.countScheduledLessons(data), 4);
  assert.equal(plan.settings.auto_sort_mode, "fast");
  assert.equal(plan.settings.preserve_existing_tkb, true);
  assert.equal(plan.settings.ui_skip_pre_solve_constraint_release, true);
  assert.equal(plan.state.eligible, true);
  assert.equal(plan.state.missing, 0);
  assert.equal(plan.released, 0);
});

test("constraint repair POST keeps every visible lesson and reports zero client-side missing periods", async () => {
  const data = makeData(4);
  const subject = data.mon[0].ten;
  const empty = () => ["", "", "", "", ""];
  const one = () => [subject, "", "", "", ""];
  data.tkb = {
    L1:{
      thu2:{sang:one(), chieu:empty()},
      thu3:{sang:one(), chieu:empty()},
      thu4:{sang:one(), chieu:empty()},
      thu5:{sang:one(), chieu:empty()}
    }
  };
  data.tkbConstraints = {teacher:{GV01:{maxDaysSessions:{maxDays:3}}}};
  let posted = null;
  const candidate = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[
      {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:1},
      {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:2},
      {classId:"L1", className:"10A1", subject, teacher:"GV01", day:3, session:"AM", period:1},
      {classId:"L1", className:"10A1", subject, teacher:"GV01", day:4, session:"AM", period:1}
    ],
    metrics:{
      scheduled_periods:4,
      expected_periods:4,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":3}
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:1}},
    unassignedLessons:[],
    warnings:[]
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      posted = JSON.parse(options.body);
      return jsonResponse(candidate);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl);
  const before = hooks.countScheduledLessons(data);
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 4, 0, 1);
  const settings = hooks.effectiveSettingsForSolve(plan.settings, data);

  const payload = await hooks.postSolve(settings, data);

  assert.ok(payload);
  assert.ok(posted);
  assert.equal(before, 4);
  assert.equal(hooks.countScheduledLessons(data), 4);
  assert.equal(hooks.countScheduledLessons(posted.data), 4);
  assert.equal(posted.settings.ui_skip_pre_solve_constraint_release, true);
  assert.equal(posted.settings.repair_existing_missing_periods, 0);
  assert.equal(posted.settings.preserve_existing_tkb, true);
});

test("constraint repair releases only one smallest teacher session and stages a fill-first solve", () => {
  const data = makeData(7);
  const subject = data.mon[0].ten;
  const empty = () => ["", "", "", "", ""];
  const one = () => [subject, "", "", "", ""];
  data.tkb = {
    L1:{
      thu2:{sang:one(), chieu:one()},
      thu3:{sang:one(), chieu:one()},
      thu4:{sang:one(), chieu:one()},
      thu5:{sang:one(), chieu:empty()},
      thu6:{sang:empty(), chieu:empty()},
      thu7:{sang:empty(), chieu:empty()}
    }
  };
  data.tkbConstraints = {
    teacher:{GV01:{maxDaysSessions:{maxSessions:6}}}
  };
  const {window, hooks} = loadBridge(data);
  const activeSessions = () => Object.values(data.tkb.L1).reduce((total, day) => (
    total
      + (day.sang.some(value => value && value !== "OFF") ? 1 : 0)
      + (day.chieu.some(value => value && value !== "OFF") ? 1 : 0)
  ), 0);
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){
      const count = activeSessions();
      return count > 6
        ? [{kind:"teacher.maxSessions", teacherId:"GV01", sessions:count, maxSessions:6}]
        : [];
    }
  };

  const released = hooks.releaseConstraintViolatingLessons(data, {silent:true});
  assert.equal(released, 1);
  assert.equal(activeSessions(), 6);
  assert.equal(hooks.countScheduledLessons(data), 6);

  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 7, released);
  assert.equal(plan.kind, "repair_constraints");
  assert.equal(plan.settings.ui_constraint_change_repair, true);
  assert.equal(plan.settings.ui_allow_staged_existing_on_fresh_sort, true);
  assert.equal(plan.settings.auto_sort_mode, "fast");
  assert.equal(plan.settings.preserve_existing_tkb, true);
  assert.equal(plan.settings.preserve_fixed_lessons_only, true);
  assert.equal(plan.settings.allow_optimize_with_fixed_lessons, true);
  assert.equal(plan.settings.require_complete_schedule, true);
  assert.equal(plan.state.eligible, true);
  assert.equal(plan.state.missing, 1);
});

test("teacher day repair resolves full subject names against PCCM subject codes", () => {
  const data = makeData(8);
  data.lop[0].ten = "6/1";
  data.lop[0].ten2 = "6/1";
  data.mon = [{khoi:"6", ten:"SĐ", sotiet:8, gioihan:2}];
  data.monhoc = [{ma:"SĐ", ten:"Sử - Địa"}];
  data.pccmMatrix = {"6/1|SĐ":"T.Thắm"};
  const empty = () => ["", "", "", "", ""];
  const lessons = count => Array.from({length:5}, (_, index) => index < count ? "Sử - Địa" : "");
  data.tkb = {
    L1:{
      thu2:{sang:lessons(2), chieu:empty()},
      thu3:{sang:lessons(1), chieu:empty()},
      thu4:{sang:lessons(3), chieu:empty()},
      thu5:{sang:lessons(2), chieu:empty()},
      thu6:{sang:empty(), chieu:empty()},
      thu7:{sang:empty(), chieu:empty()}
    }
  };
  data.tkbConstraints = {teacher:{"T.Thắm":{maxDaysSessions:{maxDays:3}}}};
  const {window, hooks} = loadBridge(data);
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){ return [{kind:"teacher.maxDays", teacherId:"T.Thắm", days:4, maxDays:3}]; }
  };

  const released = hooks.releaseConstraintViolatingLessons(data, {silent:true});

  assert.equal(released, 1);
  assert.deepEqual(data.tkb.L1.thu3.sang, empty());
  assert.equal(hooks.countScheduledLessons(data), 7);
});

test("an incomplete staged constraint repair automatically falls back to a fresh full solve", () => {
  const body = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("async function solveStagedExistingRepair"),
    BRIDGE_SOURCE.indexOf("function shouldUseInitialFastDraft")
  );
  assert.match(body, /ui_constraint_change_repair\s*===\s*true[\s\S]*!fillCompletion\.complete/);
  assert.match(body, /stagedExistingFreshRetrySettings\(baseSettings, baseData, runId\)/);
  assert.match(body, /ui_constraint_change_fresh_retry\s*=\s*true/);
});

test("an HTTP error from staged constraint repair still runs exactly one fresh fallback", async () => {
  const data = makeData(3);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{sang:[subject, "", "", "", ""], chieu:["", "", "", "", ""]},
      thu3:{sang:[subject, "", "", "", ""], chieu:["", "", "", "", ""]},
      thu4:{sang:[subject, "", "", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  data.tkbConstraints = {teacher:{GV01:{maxDaysSessions:{maxDays:2}}}};
  const completePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[1, 2, 3].map(period => ({
      classId:"L1", className:"10A1", subject, teacher:"GV01",
      day:2, session:"AM", period
    })),
    metrics:{
      scheduled_periods:3,
      expected_periods:3,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:0,
      teacher_gap2_sessions:0,
      teacher_sessions:1,
      gap_distribution:{"0":1}
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:1}},
    unassignedLessons:[],
    warnings:[]
  };
  const postedRequests = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      postedRequests.push(JSON.parse(options.body));
      if(postedRequests.length === 1){
        return jsonResponse({
          kind:"no_complete_schedule_before_deadline",
          error:"staged repair exhausted its bounded deadline"
        }, 422);
      }
      return jsonResponse(JSON.parse(JSON.stringify(completePayload)));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const {window, hooks} = loadBridge(data, fetchImpl, {console:quietConsole});
  const activeDays = () => Object.values(data.tkb?.L1 || {}).filter(sessions => (
    [...(sessions?.sang || []), ...(sessions?.chieu || [])].some(value => value && value !== "OFF")
  )).length;
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){
      return activeDays() > 2
        ? [{kind:"teacher.maxDays", message:"GV01 exceeds max teaching days"}]
        : [];
    }
  };
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 3, 0, 1);

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.ok(result);
  assert.equal(postedRequests.length, 2);
  assert.equal(hooks.countScheduledLessons(postedRequests[0].data), 3, "the UI must not pre-release the incumbent");
  assert.equal(postedRequests[0].settings.ui_staged_existing_repair, true);
  assert.equal(postedRequests[1].settings.ui_constraint_change_fresh_retry, true);
  assert.equal(postedRequests[1].settings.ui_constraint_change_rebuild_from_empty, true);
  assert.equal(postedRequests[1].data.__tkbRequestStrippedSchedule, true);
  assert.equal(postedRequests[1].data.tkb, undefined);
  assert.equal(hooks.countScheduledLessons(data), 3);
  assert.equal(activeDays(), 1);
  assert.equal(data.tkbSolverResult.solver.runtime_settings.ui_staged_fill_error, true);
  assert.equal(data.tkbSolverResult.solver.runtime_settings.ui_staged_fill_error_status, 422);
});

test("a failed constraint repair restores the exact pre-click timetable instead of progressively deleting it", () => {
  const data = makeData(4);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu3:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  data.tkbConstraints = {teacher:{GV01:{maxDaysSessions:{maxDays:1}}}};
  const {window, hooks} = loadBridge(data);
  const snapshot = hooks.snapshotScheduleData(data);

  data.tkb.L1.thu2.sang[1] = "";
  data.tkb.L1.thu3.sang[0] = "";
  data.tkb.L1.thu3.sang[1] = "";
  window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS = 3;
  assert.equal(hooks.countScheduledLessons(data), 1);

  assert.equal(hooks.restoreFailedConstraintRepairSnapshot(null, 3, data, snapshot), true);
  assert.equal(hooks.countScheduledLessons(data), 4);
  assert.equal(data.tkbConstraints.teacher.GV01.maxDaysSessions.maxDays, 1);
  assert.equal(window.__TKB_SOLVE_RELEASED_CONSTRAINT_VIOLATIONS, 0);

  data.tkb.L1.thu3.sang[1] = "";
  assert.equal(hooks.restoreFailedConstraintRepairSnapshot({ok:true}, 1, data, snapshot), false);
  assert.equal(hooks.countScheduledLessons(data), 3, "a successful result must not be rolled back");
});

test("a tightened teacher constraint first fills the released lessons without reshuffling everything", async () => {
  const data = makeData(7);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu3:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu4:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  data.tkbConstraints = {
    teacher:{GV01:{maxDaysSessions:{maxDays:3}}}
  };
  const lessons = [
    ...[2, 3, 4].flatMap(day => [1, 2].map(period => ({
      classId:"L1",
      className:"10A1",
      subject,
      teacher:"GV01",
      day,
      session:"AM",
      period
    }))),
    {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:3}
  ];
  const completePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons,
    metrics:{
      scheduled_periods:7,
      expected_periods:7,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:0,
      teacher_gap2_sessions:0,
      teacher_sessions:3,
      gap_distribution:{"0":3}
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:1}},
    unassignedLessons:[],
    warnings:[]
  };
  let solvePosts = 0;
  const postedSettings = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      postedSettings.push(JSON.parse(options.body).settings);
      return jsonResponse(completePayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){ return []; }
  };
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 7, 1, 0);

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.ok(result);
  assert.equal(solvePosts, 1, "a successful light repair must not start the full fresh fallback");
  assert.equal(postedSettings[0].ui_staged_existing_repair, true);
  assert.equal(postedSettings[0].preserve_existing_tkb, true);
  assert.equal(postedSettings[0].existing_fill_missing_schedule, true);
  assert.equal(postedSettings[0].ui_unified_partial_repair, true);
  assert.equal(postedSettings[0].allow_quality_debt, true);
  assert.equal(postedSettings[0].preserve_fixed_lessons_only, true);
  assert.equal(postedSettings[0].repair_residual_lns_time_limit_seconds, 7);
  assert.ok(postedSettings[0].overall_time_limit_seconds <= 12, JSON.stringify({
    overall:postedSettings[0].overall_time_limit_seconds,
    optimization:postedSettings[0].optimization_time_limit_seconds,
    backend:postedSettings[0].backend_deadline_ms,
    short:postedSettings[0].ui_allow_short_backend_deadline,
    phase:postedSettings[0].ui_staged_existing_phase
  }));
  assert.equal(data.tkbSolverResult.metrics.scheduled_periods, 7);
});

test("a UI-rejected complete staged repair runs one fresh rebuild and keeps the teacher constraint", async () => {
  const data = makeData(7);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu3:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu4:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  data.tkbConstraints = {
    teacher:{GV01:{maxDaysSessions:{maxDays:3}}}
  };

  const lesson = (day, period) => ({
    classId:"L1",
    className:"10A1",
    subject,
    teacher:"GV01",
    day,
    session:"AM",
    period
  });
  const stagedPayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[
      lesson(2, 1), lesson(2, 2),
      lesson(3, 1), lesson(3, 2),
      lesson(4, 1), lesson(4, 2),
      lesson(5, 1)
    ],
    metrics:{
      scheduled_periods:7,
      expected_periods:7,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:1}},
    unassignedLessons:[],
    warnings:[]
  };
  const freshPayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[
      lesson(2, 1), lesson(2, 2), lesson(2, 3),
      lesson(3, 1), lesson(3, 2),
      lesson(4, 1), lesson(4, 2)
    ],
    metrics:{
      scheduled_periods:7,
      expected_periods:7,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:2}},
    unassignedLessons:[],
    warnings:[]
  };

  let solvePosts = 0;
  const postedRequests = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      postedRequests.push(JSON.parse(options.body));
      const response = solvePosts === 1 ? stagedPayload : freshPayload;
      return jsonResponse(JSON.parse(JSON.stringify(response)));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const {window, hooks} = loadBridge(data, fetchImpl, {console:quietConsole});
  const activeTeacherDays = () => {
    const days = new Set();
    Object.entries(data.tkb?.L1 || {}).forEach(([day, sessions]) => {
      const values = [...(sessions?.sang || []), ...(sessions?.chieu || [])];
      if(values.some(value => value && value !== "OFF")) days.add(day);
    });
    return days;
  };
  const validateTeacherDays = () => activeTeacherDays().size > 3
    ? [{kind:"teacher.maxDays", message:"GV01 exceeds max teaching days"}]
    : [];
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){ return validateTeacherDays(); },
    async validateAllAsync(){ return validateTeacherDays(); }
  };
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 7, 1, 0);

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.ok(result);
  assert.equal(solvePosts, 2, "one rejected staged candidate must start exactly one fresh rebuild");
  assert.equal(postedRequests[0].settings.ui_staged_existing_repair, true);
  assert.equal(postedRequests[0].settings.preserve_existing_tkb, true);
  assert.equal(postedRequests[0].data.tkbConstraints.teacher.GV01.maxDaysSessions.maxDays, 3);
  assert.equal(postedRequests[1].settings.ui_constraint_change_fresh_retry, true);
  assert.equal(postedRequests[1].settings.ui_constraint_change_rebuild_from_empty, true);
  assert.equal(postedRequests[1].settings.overall_time_limit_seconds, 60);
  assert.equal(postedRequests[1].settings.preserve_existing_tkb, false);
  assert.equal(postedRequests[1].settings.allow_solver_warm_start, false);
  assert.equal(postedRequests[1].data.__tkbRequestStrippedSchedule, true);
  assert.equal(postedRequests[1].data.tkb, undefined, "fresh rebuild must not retain flexible incumbent cells");
  assert.equal(postedRequests[1].data.tkbConstraints.teacher.GV01.maxDaysSessions.maxDays, 3);
  assert.equal(hooks.countScheduledLessons(data), 7);
  assert.equal(activeTeacherDays().size, 3);
  assert.equal(data.tkbSolverResult.metrics.unassigned_periods, 0);
  assert.equal(window.__TKB_SOLVER_LAST_ERROR, "");
  assert.equal(window.__TKB_SOLVER_LAST_REJECTED_CANDIDATE.diagnostics.rejected_periods, 1);
  assert.equal(window.__TKB_SOLVER_LAST_REJECTED_CANDIDATE.diagnostics.released_cells.length, 1);
  assert.equal(window.__TKB_SOLVER_LAST_REJECTED_CANDIDATE.diagnostics.post_apply_violations.length, 1);
  assert.ok(Object.keys(window.__TKB_SOLVER_LAST_REJECTED_CANDIDATE.diagnostics.backend_runtime_settings).length <= 24);
  assert.equal(window.__TKB_SOLVER_LAST_PAYLOAD.solver.runtime_settings.ui_staged_apply_candidate_rejected, true);
});

test("a tightened teacher constraint stops after one staged fill and one fresh fallback", async () => {
  const data = makeData(7);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu3:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu4:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  data.tkbConstraints = {
    teacher:{GV01:{maxDaysSessions:{maxDays:3}}}
  };

  const scheduledLessons = [2, 3, 4].flatMap(day => [1, 2].map(period => ({
    classId:"L1",
    className:"10A1",
    subject,
    teacher:"GV01",
    day,
    session:"AM",
    period
  })));

  let solvePosts = 0;
  const postedSettings = [];
  const postedRequests = [];
  const incompletePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:scheduledLessons,
    metrics:{
      scheduled_periods:6,
      expected_periods:7,
      unassigned_periods:1,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      best_effort:true
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:1}},
    unassignedLessons:[{classId:"L1", subject, count:1}],
    warnings:[]
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      const request = JSON.parse(options.body);
      postedRequests.push(request);
      postedSettings.push(request.settings);
      return jsonResponse(incompletePayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const {window, hooks} = loadBridge(data, fetchImpl, {console:quietConsole});
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){ return []; }
  };
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 7, 1, 0);

  assert.equal(plan.state.eligible, true);
  assert.equal(plan.settings.ui_allow_incomplete_retry_after_single_pass, false);
  assert.equal(plan.settings.ui_stop_after_first_complete_schedule, true);
  assert.equal(plan.settings.complete_schedule_seed_retry_max_runs, 0);
  assert.equal(await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true}), null);
  assert.equal(postedSettings[0].ui_staged_existing_repair, true);
  assert.equal(solvePosts, 2, "constraint repair must not cascade into the generic robust/seed retries");
  assert.equal(postedSettings[1].ui_constraint_change_fresh_retry, true);
  assert.equal(postedSettings[1].ui_constraint_change_rebuild_from_empty, true);
  assert.equal(postedSettings[1].ui_bounded_fresh_accept_quality_debt, true);
  assert.equal(postedSettings[1].ui_constraint_change_allow_quality_debt, true);
  assert.equal(postedSettings[1].max_one_period_sessions, "off");
  assert.equal(postedSettings[1].strict_one_period_sessions_cap, false);
  assert.equal(postedSettings[1].enforce_max_one_period_sessions, false);
  assert.equal(postedSettings[1].period_max_teacher_gap, "off");
  assert.equal(postedSettings[1].ui_unified_initial_fast_stage, true);
  assert.equal(postedSettings[1].ui_disable_automatic_retry, true);
  assert.equal(postedSettings[1].ui_constraint_change_fresh_ceiling_seconds, 60);
  assert.equal(postedSettings[1].overall_time_limit_seconds, 60);
  assert.equal(postedSettings[1].backend_deadline_ms, 60000);
  assert.notEqual(postedSettings[1].robust_retry, true);
  assert.notEqual(postedSettings[1].complete_schedule_seed_retry, true);
  assert.equal(postedRequests[1].data.__tkbRequestStrippedSchedule, true);
  assert.equal(postedRequests[1].data.tkb, undefined, "fresh fallback must not send the old flexible timetable");
  assert.equal(
    postedRequests[1].data.tkbConstraints?.teacher?.GV01?.maxDaysSessions?.maxDays,
    3,
    "fresh fallback must retain the new constraints"
  );
});

test("large fixed-off fresh fallback preserves the automatic 60-second ceiling", async () => {
  const fixture = makeLargeApplyFixture(54, 29);
  const {data} = fixture;
  const subject = String(data.mon[0].ten);
  // Materialize the complete incumbent represented by makeLargeApplyFixture.
  data.tkb = {};
  for(const classInfo of data.lop){
    data.tkb[classInfo.id] = {};
    for(const day of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
      data.tkb[classInfo.id][day] = {sang:["", "", "", "", ""], chieu:["", "", "", "", ""]};
    }
  }
  for(const lesson of fixture.payload.lessons){
    const day = `thu${lesson.day}`;
    const session = String(lesson.session).toLowerCase() === "pm" ? "chieu" : "sang";
    data.tkb[lesson.classId][day][session][lesson.period - 1] = subject;
  }
  data.tkbConstraints = {
    fixedOff:{class:{L1:{"thu7|chieu|4":true}}},
    teacher:{GV01:{maxDaysSessions:{maxDays:2}}}
  };

  const postedSettings = [];
  const incompletePayload = {
    ok:true,
    classes:fixture.payload.classes,
    lessons:fixture.payload.lessons.slice(0, fixture.payload.lessons.length - 1),
    metrics:{
      scheduled_periods:1565,
      expected_periods:1566,
      unassigned_periods:1,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      best_effort:true
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:1}},
    unassignedLessons:[{classId:"L1", subject, count:1}],
    warnings:[]
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      postedSettings.push(JSON.parse(options.body).settings);
      return jsonResponse(incompletePayload);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const {window, hooks} = loadBridge(data, fetchImpl, {console:quietConsole});
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){ return []; }
  };
  data.tkbManualFreshRetryBudget = {
    version:1,
    fingerprint:hooks.durableScheduleFingerprint(data),
    nextSeconds:180,
    failures:4,
    updatedAt:Date.now()
  };
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 1566, 0, 1);
  assert.equal(plan.state.eligible, true);
  assert.equal(await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true}), null);
  assert.equal(postedSettings.length, 2);
  const fallback = postedSettings[1];
  assert.equal(fallback.ui_constraint_change_fresh_retry, true);
  assert.equal(fallback.ui_constraint_change_fresh_ceiling_seconds, 60);
  assert.equal(fallback.overall_time_limit_seconds, 60);
  assert.equal(fallback.optimization_time_limit_seconds, 60);
  assert.equal(fallback.integrated_time_limit, 60);
  assert.equal(fallback.backend_deadline_ms, 60000);
  assert.equal(fallback.native_global_deadline_ms, 60000);
  assert.equal(fallback.ui_allow_short_backend_deadline, true);
});

test("fresh fallback ignores a stale 180-second manual retry budget", () => {
  const data = makeData(7);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu3:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu4:{sang:[subject, subject, subject, "", ""], chieu:["", "", "", "", ""]}
    }
  };
  data.tkbConstraints = {teacher:{GV01:{maxDaysSessions:{maxDays:3}}}};
  const {hooks} = loadBridge(data);
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 7, 0, 1);
  const fingerprint = hooks.durableScheduleFingerprint(data);
  data.tkbManualFreshRetryBudget = {version:1, fingerprint, nextSeconds:180, failures:24};
  assert.equal(hooks.manualFreshRetryBudgetSeconds(data), 180);

  // Exercise the generic staged-repair fallback (without the constraint-change
  // marker) where the old robust retry settings leaked their 180-second cap.
  const base = Object.assign({}, plan.settings);
  delete base.ui_constraint_change_repair;
  delete base.ui_constraint_change_fresh_retry;
  const retry = hooks.stagedExistingFreshRetrySettings(base, data, "run-stale-budget");
  assert.equal(retry.ui_constraint_change_fresh_ceiling_seconds, 60);
  assert.equal(retry.ui_unified_initial_fast_stage, true);
  assert.equal(retry.ui_unified_initial_ceiling_seconds, 60);

  const effective = hooks.effectiveSettingsForSolve(retry, data);
  assert.equal(effective.overall_time_limit_seconds, 60);
  assert.equal(effective.optimization_time_limit_seconds, 60);
  assert.equal(effective.integrated_time_limit, 60);
  assert.equal(effective.backend_deadline_ms, 60000);
  assert.equal(effective.native_global_deadline_ms, 60000);
  assert.equal(effective.ui_allow_short_backend_deadline, true);

  const customBase = Object.assign({}, base, {ui_custom_solve_duration_seconds:90});
  const customRetry = hooks.stagedExistingFreshRetrySettings(customBase, data, "run-custom-budget");
  assert.equal(customRetry.ui_constraint_change_fresh_ceiling_seconds, 90);
  const customEffective = hooks.effectiveSettingsForSolve(customRetry, data);
  assert.equal(customEffective.overall_time_limit_seconds, 90);
  assert.equal(customEffective.backend_deadline_ms, 90000);
});

test("a complete violating incumbent survives two failed transactional attempts byte-for-byte", async () => {
  const data = makeData(7);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{sang:[subject, subject, subject, "", ""], chieu:["", "", "", "", ""]},
      thu3:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]},
      thu4:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}
    }
  };
  data.tkbLessonTeachers = {"L1|Toán":"GV01"};
  data.tkbLessonRooms = {"L1|Toán":"Phòng UTF-8"};
  data.tkbConstraints = {teacher:{GV01:{maxDaysSessions:{maxDays:2}}}};

  const incompletePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[
      ...[1, 2, 3].map(period => ({
        classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period
      })),
      ...[1, 2].map(period => ({
        classId:"L1", className:"10A1", subject, teacher:"GV01", day:3, session:"AM", period
      })),
      {classId:"L1", className:"10A1", subject, teacher:"GV01", day:4, session:"AM", period:1}
    ],
    metrics:{
      scheduled_periods:6,
      expected_periods:7,
      unassigned_periods:1,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      best_effort:true
    },
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{elapsed_seconds:1}},
    unassignedLessons:[{classId:"L1", subject, count:1}],
    warnings:[]
  };
  const postedRequests = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      postedRequests.push(JSON.parse(options.body));
      return jsonResponse(JSON.parse(JSON.stringify(incompletePayload)));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietConsole = {log(){}, info(){}, warn(){}, error(){}};
  const {window, hooks} = loadBridge(data, fetchImpl, {console:quietConsole});
  const teacherDays = () => Object.entries(data.tkb?.L1 || {}).filter(([, sessions]) => (
    [...(sessions?.sang || []), ...(sessions?.chieu || [])].some(value => value && value !== "OFF")
  )).length;
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){
      return teacherDays() > 2
        ? [{kind:"teacher.maxDays", message:"GV01 exceeds max teaching days"}]
        : [];
    }
  };
  const before = hooks.snapshotScheduleData(data);
  const plan = hooks.buildConstraintRepairAutoSortPlan(data, 7, 0, 1);

  assert.equal(await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true}), null);
  assert.equal(postedRequests.length, 2, "one staged attempt may start exactly one fresh fallback");
  assert.equal(hooks.countScheduledLessons(postedRequests[0].data), 7, "UI must not pre-release the violating incumbent");
  assert.equal(postedRequests[0].settings.repair_existing_missing_periods, 0);
  assert.equal(postedRequests[0].settings.ui_skip_pre_solve_constraint_release, true);
  assert.equal(postedRequests[1].settings.ui_constraint_change_fresh_retry, true);
  assert.equal(postedRequests[1].settings.ui_constraint_change_rebuild_from_empty, true);
  assert.equal(postedRequests[1].data.__tkbRequestStrippedSchedule, true);
  assert.equal(postedRequests[1].data.tkb, undefined, "no-fixed toy fallback must strip every old cell");

  const after = hooks.snapshotScheduleData(data);
  assert.deepEqual(after.tkb, before.tkb);
  assert.deepEqual(after.tkbLessonTeachers, before.tkbLessonTeachers);
  assert.deepEqual(after.tkbLessonRooms, before.tkbLessonRooms);
  assert.deepEqual(after.tkbSolverResult, before.tkbSolverResult);
  assert.equal(data.tkbConstraints.teacher.GV01.maxDaysSessions.maxDays, 2);
  assert.equal(hooks.countScheduledLessons(data), 7);
});

test("a completed solve returns its result without scheduling an optimize-more question", () => {
  const complete = makeData(1);
  complete.tkb = {L1:{thu2:{sang:[complete.mon[0].ten, "", "", "", ""], chieu:["", "", "", "", ""]}}};
  const prompts = [];
  const loaded = loadBridge(complete, null, {
    confirm(message){ prompts.push(String(message || "")); return true; }
  });
  assert.equal(loaded.hooks.scheduleOptimizeAfterCompletePrompt, undefined);
  assert.deepEqual(prompts, []);

  const body = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"),
    BRIDGE_SOURCE.indexOf("const autoSortButton", BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"))
  );
  assert.doesNotMatch(body, /scheduleOptimizeAfterCompletePrompt|B\u1ea1n c\u00f3 mu\u1ed1n t\u1ed1i \u01b0u th\u00eam kh\u00f4ng\?|window\.confirm/);
});

test("a completed fast-repair result is always refined from its incumbent", () => {
  const data = makeData(2);
  data.tkb = {L1:{thu2:{sang:[{mon:"Toán"}, {mon:"Toán"}, "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
    validation:{hard_ok:true},
    solver:{runtime_settings:{
      ui_staged_existing_repair:true,
      ui_staged_existing_phase:"fill",
      auto_sort_strategy:"staged_existing_fill_first"
    }}
  };
  const {window, hooks} = loadBridge(data);
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});

  const plan = hooks.buildAutomaticAutoSortPlan(data);

  assert.equal(plan.kind, "refine_complete");
  assert.equal(plan.settings.ui_use_existing_complete_incumbent, true);
  assert.equal(plan.settings.preserve_existing_tkb, true);
  assert.equal(plan.settings.preserve_existing_min_ratio, 1);
  assert.equal(plan.settings.ui_keep_better_existing_on_resort, true);
  assert.notEqual(plan.settings.ui_full_quality_after_partial_repair, true);
  assert.notEqual(plan.settings.ui_default_fresh_sort, true);
  assert.equal(plan.settings.auto_sort_mode, "teacher_session_opt");
  assert.equal(plan.settings.auto_sort_strategy, "continue_teacher_quality_from_incumbent");
  assert.equal(plan.settings.overall_time_limit_seconds, 180);
  assert.equal(plan.settings.backend_deadline_ms, 180000);
  assert.equal(plan.settings.optimization_unbounded_quality_search, false);
  assert.equal(plan.settings.optimization_continue_quality_search, true);
  assert.equal(plan.settings.ui_stop_refinement_when_good_enough, false);
  assert.equal(plan.settings.optimization_stop_on_stagnation, true);
  assert.equal(plan.settings.optimization_benders_accept_stagnant_iterations, 2);
  assert.equal(plan.settings.optimization_adaptive_stagnant_attempts, 2);
  assert.equal(plan.settings.optimization_adaptive_stagnant_seconds, 20);
});

test("a complete fast-repair incumbent keeps exact 10- and 20-second custom refinement budgets", async () => {
  for(const seconds of [10, 20]){
    const storage = memoryStorage();
    storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", String(seconds));
    const data = makeData(2);
    data.tkb = {L1:{thu2:{sang:[{mon:"ToÃ¡n"}, {mon:"ToÃ¡n"}, "", "", ""]}}};
    data.tkbSolverResult = {
      metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
      validation:{hard_ok:true},
      solver:{runtime_settings:{
        ui_staged_existing_repair:true,
        ui_staged_existing_phase:"fill",
        auto_sort_strategy:"staged_existing_fill_first"
      }}
    };
    let posted = null;
    const fetchImpl = async (url, options = {}) => {
      const requestUrl = String(url);
      if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
      if(requestUrl.endsWith("/api/solve-data")){
        posted = JSON.parse(options.body);
        return jsonResponse({ok:false, kind:"duration_probe", error:"duration probe"}, 422);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const {window, hooks} = loadBridge(data, fetchImpl, {localStorage:storage});
    window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});

    const plan = hooks.buildAutomaticAutoSortPlan(data);
    const effective = hooks.effectiveSettingsForSolve(plan.settings, data);
    assert.equal(plan.kind, "refine_complete");
    assert.equal(plan.settings.ui_custom_solve_duration_seconds, seconds);
    assert.equal(plan.settings.ui_fresh_solve_duration_floor_applied, undefined);
    assert.equal(plan.settings.preserve_existing_tkb, true);
    assert.equal(plan.settings.preserve_existing_min_ratio, 1);
    assert.equal(plan.settings.ui_keep_better_existing_on_resort, true);
    assert.equal(effective.overall_time_limit_seconds, seconds);
    assert.equal(effective.optimization_time_limit_seconds, seconds);
    assert.equal(effective.integrated_time_limit, seconds);
    assert.equal(effective.backend_deadline_ms, seconds * 1000);
    assert.equal(effective.native_global_deadline_ms, seconds * 1000);

    await assert.rejects(hooks.postSolve(plan.settings, data));
    assert.ok(posted);
    assert.equal(posted.settings.ui_unified_solve_kind, "refine_complete");
    assert.equal(posted.settings.preserve_existing_tkb, true);
    assert.equal(posted.settings.preserve_existing_min_ratio, 1);
    assert.equal(posted.settings.ui_keep_better_existing_on_resort, true);
    assert.equal(posted.settings.overall_time_limit_seconds, seconds);
    assert.equal(posted.settings.optimization_time_limit_seconds, seconds);
    assert.equal(posted.settings.integrated_time_limit, seconds);
    assert.equal(posted.settings.backend_deadline_ms, seconds * 1000);
    assert.equal(posted.settings.native_global_deadline_ms, seconds * 1000);
    assert.equal(posted.settings.fresh_randomize, true);
    assert.equal(posted.settings.randomize_search, true);
    assert.ok(Number.isInteger(posted.settings.random_seed));
    assert.equal(posted.settings.quality_variant_seed, posted.settings.random_seed);
    assert.equal(storage.getItem("TKB_SOLVE_DURATION_SECONDS_V2"), String(seconds));
  }
});

test("solve timing learning persists in school data for cross-device refinement", () => {
  const data = makeData(2);
  data.tkb = {L1:{thu2:{sang:[{mon:"Toán"}, {mon:"Toán"}, "", "", ""]}}};
  data.tkbSolverResult = {
    metrics:{optimization_refinement_round:1},
    solver:{runtime_settings:{optimization_refinement_round:1}}
  };
  const {hooks} = loadBridge(data);
  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const key = hooks.solveTimingProfileKey(plan.settings, data);
  data.tkbAdaptiveLearning = {
    version:1,
    solveTimings:{[key]:{estimateSeconds:15, updatedAt:100}}
  };

  assert.equal(hooks.readSolveTimingEstimate(plan.settings, data), 18);
  hooks.rememberSolveTiming(plan.settings, data, 25);
  assert.ok(data.tkbAdaptiveLearning.solveTimings[key].estimateSeconds > 15);
  assert.equal(data.tkbAdaptiveLearning.solveTimings[key].lastElapsedSeconds, 25);
  assert.equal(data.tkbAdaptiveLearning.version, 1);
});

test("refinement operator learning survives a rejected timetable and enters the next request", () => {
  const data = makeData(2);
  const {hooks} = loadBridge(data);
  const snapshot = hooks.snapshotScheduleData(data);
  const firstLearning = {
    version:2,
    school_signature:123456,
    total_attempts:2,
    operators:{
      session_merge:{attempts:2, improvements:1, reward:4.2, seconds:3.5, last_round:1}
    }
  };

  assert.equal(hooks.rememberRefinementLearning(data, firstLearning), true);
  data.tkb = {temporary:{}};
  hooks.restoreScheduleData(data, snapshot);
  assert.equal(data.tkbRefinementLearning.total_attempts, 2);
  assert.equal(data.tkbRefinementLearning.operators.session_merge.attempts, 2);

  const nextRequest = hooks.dataForSolverRequest(data, {allow_solver_warm_start:false});
  assert.deepEqual(nextRequest.tkbRefinementLearning, data.tkbRefinementLearning);
  assert.equal(nextRequest.tkbSolverResult, undefined);

  const cumulativePayload = {
    solver:{
      runtime_settings:{
        refinement_learning:{
          version:2,
          school_signature:123456,
          total_attempts:4,
          operators:{
            session_merge:{attempts:3, improvements:2, reward:8.4, seconds:6.5, last_round:2},
            gap1:{attempts:1, improvements:0, reward:0, seconds:2, last_round:2}
          }
        }
      }
    }
  };
  assert.equal(hooks.rememberRefinementLearning(data, cumulativePayload), true);
  assert.equal(data.tkbRefinementLearning.total_attempts, 4);
  assert.equal(data.tkbRefinementLearning.operators.session_merge.attempts, 3);
  assert.equal(data.tkbRefinementLearning.operators.gap1.attempts, 1);

  assert.equal(hooks.rememberRefinementLearning(data, firstLearning), false);
  assert.equal(data.tkbRefinementLearning.total_attempts, 4);
});

test("automatic budgets do not change with timetable size", () => {
  const data = makeData(1500);
  const {hooks} = loadBridge(data);

  assert.equal(hooks.automaticSolverCeilingSeconds(1500, data), 60);
  assert.equal(hooks.incrementalRefineCeilingSeconds(1500, data), 180);
  assert.equal(hooks.incrementalRefineCeilingSeconds(600, data), 180);
});

test("refinement round survives POST, result application, and the next plan", async () => {
  const data = makeData(2);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{
        sang:[subject, subject, "", "", ""],
        chieu:["", "", "", "", ""]
      }
    }
  };
  data.tkbSolverResult = {
    lessons:[
      {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:1},
      {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:2}
    ],
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      teacher_sessions:1,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":1},
      optimization_refinement_round:3
    },
    validation:{hard_ok:true},
    solver:{
      runtime_settings:{
        auto_sort_mode:"teacher_session_opt",
        quality_priority_order:"one_period_gap2_teacher_sessions_gap1",
        optimization_refinement_round:3
      }
    }
  };

  let posted = null;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(!requestUrl.endsWith("/api/solve-data")) throw new Error(`Unexpected URL: ${url}`);
    posted = JSON.parse(options.body);
    const round = posted.settings.optimization_refinement_round;
    return jsonResponse({
      ok:true,
      classes:[{id:"L1", name:"10A1"}],
      lessons:[
        {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:1},
        {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:2}
      ],
      metrics:{
        scheduled_periods:2,
        expected_periods:2,
        unassigned_periods:0,
        app_constraint_violation_count:0,
        hard_ok:true,
        core_hard_ok:true,
        teacher_sessions:1,
        one_period_teacher_sessions:0,
        gap_distribution:{"0":1},
        optimization_refinement_round:round
      },
      validation:{hard_ok:true},
      solver:{
        runtime_settings:{
          auto_sort_mode:"teacher_session_opt",
          quality_priority_order:"one_period_gap2_teacher_sessions_gap1",
          optimization_refinement_round:round,
          elapsed_seconds:0.1
        }
      },
      warnings:[],
      unassignedLessons:[]
    });
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});

  const plan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(plan.settings.optimization_refinement_round, 4);
  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.ok(result);
  assert.equal(posted.settings.optimization_refinement_round, 4);
  assert.equal(posted.data.tkbSolverResult.lessons.length, 2);
  assert.equal(posted.data.tkbSolverResult.solver.runtime_settings.optimization_refinement_round, 3);
  assert.ok(posted.data.tkb.L1);
  assert.equal(data.tkbSolverResult.solver.runtime_settings.optimization_refinement_round, 4);
  assert.equal(hooks.buildAutomaticAutoSortPlan(data).settings.optimization_refinement_round, 5);
});

test("stale backend goal flags cannot hide gap2 or one-period debt", () => {
  const data = makeData(2);
  const {hooks} = loadBridge(data);
  const clean = {
    metrics:{
      hard_ok:true,
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      teacher_sessions:1,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":1}
    },
    validation:{hard_ok:true},
    solver:{teacher_session_optimization:{target_met:true}}
  };
  assert.equal(hooks.teacherSessionOptGoalSatisfied(clean), true);
  assert.equal(hooks.teacherSessionOptGoalSatisfied({
    ...clean,
    metrics:{...clean.metrics, gap_distribution:{"2":1}}
  }), false);
  assert.equal(hooks.teacherSessionOptGoalSatisfied({
    ...clean,
    metrics:{...clean.metrics, one_period_teacher_sessions:1}
  }), false);
  assert.equal(hooks.teacherSessionOptGoalSatisfied({
    ...clean,
    metrics:{...clean.metrics, hard_ok:false}
  }), false);
});

test("physical cell count cannot hide a subject-demand shortfall", () => {
  const data = makeData(2);
  data.tkb = {L1:{thu2:{sang:[{mon:"ToÃ¡n"}, {mon:"Sai mÃ´n"}, "", "", ""]}}};
  const {window, hooks} = loadBridge(data);
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:1, chuaXepTiet:1});

  const stats = hooks.cheapSchoolCompletionStats(data);
  const plan = hooks.buildAutomaticAutoSortPlan(data);
  assert.equal(stats.unassigned, 1);
  assert.equal(stats.scheduled, 1);
  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(plan.settings.ui_unified_solve_kind, "fresh_complete_first");
  assert.equal(plan.settings.auto_sort_mode, "teacher_session_opt");
  assert.notEqual(plan.settings.preserve_existing_tkb, true);
});

test("Fast preset budgets survive effective-settings normalization", () => {
  const cases = [
    {expected:500, fixedOff:false, seconds:60},
    {expected:700, fixedOff:false, seconds:90},
    {expected:1000, fixedOff:false, seconds:120},
    {expected:500, fixedOff:true, seconds:75},
    {expected:700, fixedOff:true, seconds:105},
    {expected:1000, fixedOff:true, seconds:150}
  ];

  for(const item of cases){
    const data = makeData(item.expected, {fixedOff:item.fixedOff});
    const {hooks} = loadBridge(data);
    const plan = hooks.buildFreshQualityAutoSortSettings(data, undefined, "fast");
    const effective = hooks.effectiveSettingsForSolve(plan.settings, data);
    assert.equal(effective.ui_solver_preset, "fast");
    assert.equal(effective.auto_sort_mode, "fast");
    assert.equal(effective.overall_time_limit_seconds, item.seconds);
    assert.equal(effective.integrated_time_limit, item.seconds);
    assert.equal(effective.optimization_time_limit_seconds, item.seconds);
    assert.equal(hooks.fastPresetDeadlineSeconds(item.expected, data), item.seconds);
    assert.equal(effective.minimize_one_period_sessions, true);
    assert.equal(effective.max_one_period_sessions, "off");
    assert.equal(effective.strict_one_period_sessions_cap, false);
    assert.equal(effective.enforce_max_one_period_sessions, false);
    assert.equal(effective.one_period_priority_absolute, false);
    assert.equal(effective.allow_quality_debt, true);
    assert.equal(effective.session_early_stop_enabled, false);
    assert.equal(effective.optimization_continue_quality_search, true);
    assert.equal(effective.ui_no_hint_randomized_solve, true);
    assert.ok(Number(effective.random_seed) > 0);
    assert.equal(effective.fast_quality_warmup_direct, true);
    assert.ok(effective.fast_quality_teacher_cap > 0);
    if(item.expected >= 900){
      assert.ok(effective.fast_quality_teacher_cap >= effective.target_teacher_sessions);
    }
  }
});

test("Max preset remains a distinct teacher-session optimization profile", () => {
  const data = makeData(1000);
  const {hooks} = loadBridge(data);
  const plan = hooks.buildFreshQualityAutoSortSettings(data, undefined, "balanced");
  const effective = hooks.effectiveSettingsForSolve(plan.settings, data);

  assert.equal(effective.ui_solver_preset, "balanced");
  assert.equal(effective.auto_sort_mode, "teacher_session_opt");
  assert.equal(effective.auto_sort_strategy, "fresh_teacher_session_opt");
  assert.ok(effective.overall_time_limit_seconds >= 360);
  assert.ok(effective.optimization_time_limit_seconds >= 360);
  assert.ok(effective.optimization_adaptive_time_limit_seconds >= 150);
  assert.equal(effective.minimize_one_period_sessions, true);
  assert.equal(effective.max_one_period_sessions, 0);
  assert.equal(effective.strict_one_period_sessions_cap, true);
  assert.equal(effective.enforce_max_one_period_sessions, true);
  assert.equal(effective.one_period_priority_absolute, true);
  assert.equal(effective.allow_quality_debt, false);
  assert.equal(effective.session_early_stop_enabled, false);
  assert.equal(effective.optimization_continue_quality_search, true);
  assert.equal(effective.ui_no_hint_randomized_solve, true);
  assert.ok(Number(effective.random_seed) > 0);
  assert.equal(effective.fast_quality_warmup_direct, false);
  assert.equal(effective.fast_quality_teacher_cap, undefined);
  assert.equal(effective.ui_keep_better_existing_on_resort, true);
  assert.equal(effective.target_teacher_sessions, undefined);
  assert.equal(effective.teacher_session_target_explicit, undefined);
  assert.equal(effective.session_early_stop_teacher_sessions, undefined);
  assert.ok(effective.optimization_accept_teacher_sessions > 0);
  assert.equal(effective.target_gap1_sessions, 0);
  assert.ok(effective.optimization_accept_gap1_sessions >= 0);
  assert.equal(effective.gap1_quality_target_explicit, true);

  const fixedData = makeData(1300, {fixedOff:true});
  const fixedBridge = loadBridge(fixedData);
  const fixedPlan = fixedBridge.hooks.buildFreshQualityAutoSortSettings(fixedData, undefined, "balanced");
  const fixedEffective = fixedBridge.hooks.effectiveSettingsForSolve(fixedPlan.settings, fixedData);
  assert.equal(fixedEffective.optimization_adaptive_time_limit_seconds, 180);
});

test("quality replacement rejects a gap-1 improvement that increases teacher sessions", () => {
  const data = makeData(1000);
  const {hooks} = loadBridge(data);
  const incumbent = {
    solver: {teacher_session_optimization: {target_gap1_sessions: 0}},
    metrics: {
      teacher_sessions: 465,
      one_period_teacher_sessions: 0,
      gap_distribution: {0: 425, 1: 40}
    }
  };
  const candidate = {
    solver: {teacher_session_optimization: {target_gap1_sessions: 0}},
    metrics: {
      teacher_sessions: 472,
      one_period_teacher_sessions: 0,
      gap_distribution: {0: 437, 1: 35}
    }
  };

  assert.deepEqual(Array.from(hooks.teacherSessionQuality(candidate, true).slice(0, 4)), [0, 35, 0, 472]);
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(candidate, incumbent), false);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(candidate, incumbent), false);
});

test("unified quality keeps fewer teacher sessions ahead of gap-1 polish", () => {
  const data = makeData(1000);
  const {hooks} = loadBridge(data);
  const priority = "one_period_gap2_teacher_sessions_gap1";
  const incumbent = {
    solver: {runtime_settings: {quality_priority_order: priority, auto_sort_mode: "teacher_session_opt"}},
    metrics: {
      teacher_sessions: 465,
      one_period_teacher_sessions: 0,
      gap_distribution: {0: 425, 1: 40},
      auto_sort_mode: "teacher_session_opt"
    }
  };
  const candidate = {
    solver: {runtime_settings: {quality_priority_order: priority, auto_sort_mode: "teacher_session_opt"}},
    metrics: {
      teacher_sessions: 472,
      one_period_teacher_sessions: 0,
      gap_distribution: {0: 437, 1: 35},
      auto_sort_mode: "teacher_session_opt"
    }
  };

  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(candidate, incumbent), false);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(candidate, incumbent), false);

  const dirty = {
    solver: {runtime_settings: {quality_priority_order: priority, auto_sort_mode: "teacher_session_opt"}},
    metrics: {
      teacher_sessions: 465,
      one_period_teacher_sessions: 1,
      gap_distribution: {0: 464},
      auto_sort_mode: "teacher_session_opt"
    }
  };
  const debtTradeoff = {
    solver: {runtime_settings: {quality_priority_order: priority, auto_sort_mode: "teacher_session_opt"}},
    metrics: {
      teacher_sessions: 470,
      one_period_teacher_sessions: 0,
      gap_distribution: {0: 468, 2: 2},
      auto_sort_mode: "teacher_session_opt"
    }
  };
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(debtTradeoff, dirty), false);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(debtTradeoff, dirty), false);
  debtTradeoff.metrics.gap_distribution = {0: 470};
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(debtTradeoff, dirty), false);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(debtTradeoff, dirty), false);
  debtTradeoff.metrics.teacher_sessions = 465;
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(debtTradeoff, dirty), true);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(debtTradeoff, dirty), true);
});

test("best-so-far quality rejects every visible regression regardless of runtime", () => {
  const data = makeData(1000);
  const {hooks} = loadBridge(data);
  const priority = "one_period_gap2_teacher_sessions_gap1";
  const payload = (teacherSessions, gap1, onePeriod = 0, gap2Plus = 0) => ({
    solver:{runtime_settings:{quality_priority_order:priority}},
    metrics:{
      scheduled_periods:1000,
      expected_periods:1000,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      teacher_sessions:teacherSessions,
      one_period_teacher_sessions:onePeriod,
      gap_distribution:{"1":gap1, "2":gap2Plus}
    },
    validation:{hard_ok:true}
  });
  const incumbent = payload(468, 40);
  const sessionsRegression = payload(469, 0);
  const unboundedGap1Tradeoff = payload(460, 45);
  const boundedGap1Tradeoff = payload(460, 44);
  const paretoImprovement = payload(460, 40);
  const equalCandidate = payload(468, 40);
  const productionIncumbent = payload(519, 62, 17);
  const productionSkewedCandidate = payload(517, 76, 1);
  const hiddenImbalanceIncumbent = payload(478, 59);
  hiddenImbalanceIncumbent.metrics.teacher_gap1_session_imbalance = 2;
  const primaryParetoImprovement = payload(470, 50);
  primaryParetoImprovement.metrics.teacher_gap1_session_imbalance = 3;

  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(sessionsRegression, incumbent), false);
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(sessionsRegression, incumbent), false);
  assert.equal(hooks.shouldKeepIncumbentForTeacherQuality(sessionsRegression, incumbent, {complete:true}), true);
  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(unboundedGap1Tradeoff, incumbent), false);
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(unboundedGap1Tradeoff, incumbent), false);
  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(boundedGap1Tradeoff, incumbent), false);
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(boundedGap1Tradeoff, incumbent), false);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(boundedGap1Tradeoff, incumbent), false);
  assert.equal(hooks.shouldKeepIncumbentForTeacherQuality(boundedGap1Tradeoff, incumbent, {complete:true}), true);
  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(paretoImprovement, incumbent), true);
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(paretoImprovement, incumbent), true);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(paretoImprovement, incumbent), true);
  assert.equal(hooks.shouldKeepIncumbentForTeacherQuality(paretoImprovement, incumbent, {complete:true}), false);
  assert.equal(hooks.payloadBetterOrEqualTeacherQuality(equalCandidate, incumbent), false);
  assert.equal(hooks.shouldKeepIncumbentForTeacherQuality(equalCandidate, incumbent, {complete:true}), true);
  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(payload(460, 0, 1), incumbent), false);
  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(payload(460, 0, 0, 1), incumbent), false);
  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(productionSkewedCandidate, productionIncumbent), false);
  assert.equal(hooks.shouldKeepIncumbentForTeacherQuality(productionSkewedCandidate, productionIncumbent, {complete:true}), true);
  assert.equal(hooks.candidateWithinVisibleQualityEnvelope(primaryParetoImprovement, hiddenImbalanceIncumbent), true);
  assert.equal(hooks.payloadStrictlyBetterTeacherQuality(primaryParetoImprovement, hiddenImbalanceIncumbent), true);
});

test("retained incumbent inherits the attempted refinement round", () => {
  const data = makeData(2);
  const {hooks} = loadBridge(data);
  const incumbent = {
    metrics:{optimization_refinement_round:1},
    solver:{runtime_settings:{optimization_refinement_round:1}}
  };
  const candidate = {
    metrics:{optimization_refinement_round:4},
    solver:{runtime_settings:{optimization_refinement_round:4}}
  };
  assert.equal(hooks.inheritRefinementRound(incumbent, candidate), 4);
  assert.equal(incumbent.metrics.optimization_refinement_round, 4);
  assert.equal(incumbent.solver.runtime_settings.optimization_refinement_round, 4);
});

test("restoring an equal-visible refinement advances the next search round", () => {
  const autoSortBody = BRIDGE_SOURCE.slice(
    BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"),
    BRIDGE_SOURCE.indexOf("const autoSortButton", BRIDGE_SOURCE.indexOf("window.sapXepTuDongAll = async function"))
  );
  assert.match(
    autoSortBody,
    /!statisticsImproved[\s\S]*restoreUnimprovedRefinementSnapshot\(\s*getData\(\),\s*scheduleSnapshotBeforeAutoSort,\s*candidatePayloadAfterAutoSort\s*\)/
  );

  const data = makeData(2);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}}
  };
  data.tkbSolverResult = {
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      hard_ok:true,
      teacher_sessions:1,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":1},
      optimization_refinement_round:3
    },
    validation:{hard_ok:true},
    solver:{runtime_settings:{optimization_refinement_round:3}}
  };
  const {window, hooks} = loadBridge(data);
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});
  const incumbentSnapshot = hooks.snapshotScheduleData(data);

  data.tkb = {
    L1:{thu3:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}}
  };
  data.tkbSolverResult = {
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      hard_ok:true,
      teacher_sessions:1,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":1},
      optimization_refinement_round:4
    },
    validation:{hard_ok:true},
    solver:{runtime_settings:{optimization_refinement_round:4}}
  };

  const restored = hooks.restoreUnimprovedRefinementSnapshot(
    data,
    incumbentSnapshot,
    data.tkbSolverResult
  );

  assert.ok(data.tkb.L1.thu2, "the visible incumbent timetable must be restored");
  assert.equal(data.tkb.L1.thu3, undefined);
  assert.equal(restored.metrics.optimization_refinement_round, 4);
  assert.equal(restored.solver.runtime_settings.optimization_refinement_round, 4);
  assert.equal(hooks.buildAutomaticAutoSortPlan(data).settings.optimization_refinement_round, 5);
});

test("Fast accepts one-period quality debt while Max keeps the zero hard cap", () => {
  const data = makeData(10);
  const {hooks} = loadBridge(data);
  const fast = hooks.effectiveSettingsForSolve(
    hooks.buildFreshQualityAutoSortSettings(data, undefined, "fast").settings,
    data
  );
  const max = hooks.effectiveSettingsForSolve(
    hooks.buildFreshQualityAutoSortSettings(data, undefined, "balanced").settings,
    data
  );
  const payload = {
    metrics: {
      scheduled_periods:10,
      expected_periods:10,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:1
    },
    validation:{hard_ok:true},
    lessons:[{}]
  };

  assert.equal(hooks.hardQualityViolationMessage(payload, fast), "");
  assert.match(hooks.hardQualityViolationMessage(payload, max), /1 tiết/);
});

test("long unified sorting keeps quality strict first but accepts unavoidable debt", () => {
  const data = makeData(10);
  const storage = memoryStorage();
  storage.setItem("TKB_SOLVE_DURATION_SECONDS_V2", "180");
  const {hooks} = loadBridge(data, null, {localStorage:storage});
  const unified = hooks.effectiveSettingsForSolve(
    hooks.buildAutomaticAutoSortPlan(data).settings,
    data
  );
  const payload = {
    metrics: {
      scheduled_periods:10,
      expected_periods:10,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:10
    },
    validation:{hard_ok:true},
    lessons:[{}]
  };

  assert.equal(unified.ui_unified_auto_sort, true);
  assert.equal(unified.ui_bounded_fresh_accept_quality_debt, true);
  assert.equal(unified.quality_priority_order, "one_period_gap2_teacher_sessions_gap1");
  assert.equal(unified.require_complete_schedule, true);
  assert.equal(unified.minimize_one_period_sessions, true);
  assert.equal(unified.max_one_period_sessions, "off");
  assert.equal(unified.strict_one_period_sessions_cap, false);
  assert.equal(unified.enforce_max_one_period_sessions, false);
  assert.equal(unified.one_period_priority_absolute, false);
  assert.equal(unified.allow_quality_debt, true);
  assert.equal(hooks.hardQualityViolationMessage(payload, unified), "");

  const gap2Invalid = structuredClone(payload);
  gap2Invalid.metrics.one_period_teacher_sessions = 0;
  gap2Invalid.metrics.gap_distribution = {"0":9, "2":1};
  assert.equal(hooks.hardQualityViolationMessage(gap2Invalid, unified), "");

  const hardInvalid = structuredClone(payload);
  hardInvalid.metrics.scheduled_periods = 0;
  hardInvalid.metrics.app_constraint_violation_count = 1;
  hardInvalid.metrics.hard_ok = false;
  hardInvalid.validation.hard_ok = false;
  hardInvalid.lessons = [];
  assert.match(hooks.hardQualityViolationMessage(hardInvalid, unified), /ràng buộc cứng/);
});

test("bounded unified sorting accepts unavoidable one-period and gap-2 debt", () => {
  const data = makeData(10);
  const {hooks} = loadBridge(data);
  const unified = hooks.effectiveSettingsForSolve(
    hooks.buildAutomaticAutoSortPlan(data).settings,
    data
  );
  const onePeriod = {
    metrics:{
      scheduled_periods:10,
      expected_periods:10,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:1,
      gap_distribution:{"0":9}
    },
    validation:{hard_ok:true},
    lessons:[{}]
  };
  const gap2 = structuredClone(onePeriod);
  gap2.metrics.one_period_teacher_sessions = 0;
  gap2.metrics.gap_distribution = {"0":9, "2":1};

  assert.equal(unified.ui_bounded_fresh_accept_quality_debt, true);
  assert.equal(unified.max_one_period_sessions, "off");
  assert.equal(unified.strict_one_period_sessions_cap, false);
  assert.equal(unified.enforce_max_one_period_sessions, false);
  assert.equal(unified.one_period_priority_absolute, false);
  assert.equal(unified.allow_quality_debt, true);
  assert.equal(unified.period_max_teacher_gap, "off");
  assert.equal(hooks.hardQualityViolationMessage(onePeriod, unified), "");
  assert.equal(hooks.hardQualityViolationMessage(gap2, unified), "");
});

test("bounded unified lifecycle applies a complete schedule with unavoidable quality debt", async () => {
  const data = makeData(1);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const progress = createProgressDocument(clock);
  clock.document = progress.document;
  const subject = data.mon[0].ten;
  const completePayload = {
    ok:true,
    classes:[{id:"L1", name:"10A1"}],
    lessons:[{
      classId:"L1",
      className:"10A1",
      subject,
      teacher:"GV01",
      day:2,
      session:"AM",
      period:1
    }],
    metrics:{
      scheduled_periods:1,
      expected_periods:1,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      one_period_teacher_sessions:1,
      teacher_gap2_sessions:0,
      teacher_sessions:1,
      gap_distribution:{"1":0}
    },
    validation:{hard_ok:true},
    solver:{runtime_settings:{elapsed_seconds:0.1}},
    unassignedLessons:[],
    warnings:[]
  };
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")) return jsonResponse(completePayload);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  const plan = hooks.buildAutomaticAutoSortPlan(data);

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.equal(result.metrics.scheduled_periods, 1);
  assert.equal(result.metrics.one_period_teacher_sessions, 1);
  assert.equal(hooks.countScheduledLessons(data), 1);
  assert.equal(progress.button.disabled, false);
  assert.equal(progress.home.hidden, false);
  assert.equal(progress.home.disabled, false);
  assert.ok(progress.events.some(event => (
    event.type === "attribute"
    && event.id === "btnHome"
    && event.name === "aria-disabled"
    && event.value === "true"
  )), "Home must be locked while sorting");
  assert.equal(progress.events.some(event => (
    event.type === "hidden" && event.id === "btnHome" && event.value === true
  )), false, "Home must keep its toolbar slot while sorting");
  assert.equal(progress.wrap.hidden, true);
  assert.equal(progress.wrap.classList.contains("is-complete"), false);
  assert.equal(progress.pct.textContent, "0%");
  assert.equal(progress.label.textContent, "Sẵn sàng");
  assert.equal(progress.nodes.get("statusMsg").textContent, "Đã xếp xong!");
});

test("27-second unchanged refinement stays synchronized and uses concise completion text", async () => {
  const data = makeData(2);
  const subject = data.mon[0].ten;
  data.tkb = {
    L1:{
      thu2:{
        sang:[subject, subject, "", "", ""],
        chieu:["", "", "", "", ""]
      }
    }
  };
  data.tkbSolverResult = {
    metrics:{
      scheduled_periods:2,
      expected_periods:2,
      unassigned_periods:0,
      app_constraint_violation_count:0,
      hard_ok:true,
      core_hard_ok:true,
      teacher_sessions:1,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":1},
      optimization_refinement_round:3
    },
    validation:{hard_ok:true},
    solver:{
      runtime_settings:{
        auto_sort_mode:"teacher_session_opt",
        quality_priority_order:"one_period_gap2_teacher_sessions_gap1",
        optimization_refinement_round:3
      }
    }
  };
  const clock = createFakeClock(1_700_000_000_000, 0);
  clock.enableIntervals = true;
  const progress = createProgressDocument(clock);
  clock.document = progress.document;
  let posted = null;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(!requestUrl.endsWith("/api/solve-data")) throw new Error(`Unexpected URL: ${url}`);
    posted = JSON.parse(options.body);
    clock.advance(27_000);
    const round = posted.settings.optimization_refinement_round;
    return jsonResponse({
      ok:true,
      classes:[{id:"L1", name:"10A1"}],
      lessons:[
        {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:1},
        {classId:"L1", className:"10A1", subject, teacher:"GV01", day:2, session:"AM", period:2}
      ],
      metrics:{
        scheduled_periods:2,
        expected_periods:2,
        unassigned_periods:0,
        app_constraint_violation_count:0,
        hard_ok:true,
        core_hard_ok:true,
        teacher_sessions:1,
        one_period_teacher_sessions:0,
        gap_distribution:{"0":1},
        optimization_refinement_round:round
      },
      validation:{hard_ok:true},
      solver:{
        runtime_settings:{
          auto_sort_mode:"teacher_session_opt",
          quality_priority_order:"one_period_gap2_teacher_sessions_gap1",
          optimization_refinement_round:round,
          elapsed_seconds:27
        }
      },
      warnings:[],
      unassignedLessons:[]
    });
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  window.calcSchoolTKBStats = () => ({soTiet:2, daXepTiet:2, chuaXepTiet:0});
  window.setAutoSortProgress = (percent, label) => {
    progress.wrap.hidden = false;
    progress.wrap.classList.add("is-active");
    progress.pct.textContent = `${Math.round(Number(percent) || 0)}%`;
    progress.label.textContent = String(label || "");
  };
  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const startedAt = clock.now();

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.ok(result);
  assert.equal(clock.now() - startedAt, 27_000);
  const percentEvents = progress.events.filter(event => (
    event.type === "text" && event.id === "autoSortProgressPct"
  ));
  const values = percentEvents.map(event => Number.parseInt(event.value, 10)).filter(Number.isFinite);
  const completeIndex = values.indexOf(100);
  const runningValues = completeIndex >= 0 ? values.slice(0, completeIndex) : values;
  assert.ok(runningValues.length > 0, `expected running progress, got ${values.join(",")}`);
  assert.ok(Math.max(...runningValues) < 30, `27 seconds must stay early in a 180-second slice, got ${values.join(",")}`);
  assert.equal(values.includes(99), false, `an early result must not manufacture 99%, got ${values.join(",")}`);
  assert.equal(completeIndex, -1, `an unchanged refinement must not manufacture 100%, got ${values.join(",")}`);
  assert.ok(progress.events.some(event => (
    event.type === "text"
    && event.id === "autoSortProgressLabel"
    && event.value === "27 giây"
  )));
  assert.equal(progress.wrap.hidden, true);
  assert.equal(progress.pct.textContent, "0%");
  assert.equal(progress.label.textContent, "Sẵn sàng");
  assert.equal(
    progress.nodes.get("statusMsg").textContent,
    "Đã xếp xong!"
  );
  clock.advance(6_000);
  assert.equal(progress.wrap.hidden, true);
  assert.equal(progress.pct.textContent, "0%");
  assert.equal(progress.label.textContent, "Sẵn sàng");
  assert.equal(progress.nodes.get("statusMsg").textContent, "Đã xếp xong!");
});

test("failed solve lifecycle never paints a fake 100%", async () => {
  const data = makeData(1);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const progress = createProgressDocument(clock);
  clock.document = progress.document;
  clock.console = Object.assign({}, console, {error(){}});
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      return jsonResponse({ok:false, error:"test failure", kind:"invalid_request"}, 400);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  const plan = hooks.buildAutomaticAutoSortPlan(data);

  const result = await window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});

  assert.equal(result, null);
  assert.equal(progress.home.hidden, false);
  assert.equal(progress.home.disabled, false);
  assert.ok(progress.events.some(event => (
    event.type === "attribute"
    && event.id === "btnHome"
    && event.name === "aria-disabled"
    && event.value === "true"
  )), "Home must be locked during a failed solve");
  assert.equal(progress.events.some(event => (
    event.type === "hidden" && event.id === "btnHome" && event.value === true
  )), false, "Home must remain in place during a failed solve");
  assert.equal(progress.pct.textContent, "!");
  assert.equal(progress.wrap.classList.contains("is-error"), true);
  assert.equal(progress.events.some(event => (
    event.type === "text" && event.id === "autoSortProgressPct" && event.value === "100%"
  )), false);
});

test("cancelled solve lifecycle never paints a fake 100%", async () => {
  const data = makeData(1);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const progress = createProgressDocument(clock);
  clock.document = progress.document;
  let markSolveStarted;
  const solveStarted = new Promise(resolve => { markSolveStarted = resolve; });
  const fetchImpl = (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return Promise.resolve(jsonResponse({ok:true, api:"rust"}));
    if(requestUrl.endsWith("/api/solve-cancel")){
      return Promise.resolve(jsonResponse({ok:true, cancelRequested:true}));
    }
    if(requestUrl.endsWith("/api/solve-data")){
      markSolveStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("cancelled by test");
          err.name = "AbortError";
          reject(err);
        }, {once:true});
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  const plan = hooks.buildAutomaticAutoSortPlan(data);
  const solvePromise = window.TKBRustAPI.solve({ask:false, settings:plan.settings, singlePass:true});
  await solveStarted;
  window.__AUTO_SORT_STOP_REQUESTED = true;
  await window.requestStopAutoSort();

  const result = await solvePromise;
  assert.equal(result, null);
  assert.equal(progress.home.hidden, false);
  assert.equal(progress.home.disabled, false);
  assert.ok(progress.events.some(event => (
    event.type === "attribute"
    && event.id === "btnHome"
    && event.name === "aria-disabled"
    && event.value === "true"
  )), "Home must stay locked until cancellation finishes");
  assert.equal(progress.events.some(event => (
    event.type === "hidden" && event.id === "btnHome" && event.value === true
  )), false, "Home must retain its toolbar slot until cancellation finishes");
  assert.equal(progress.pct.textContent, "!");
  assert.equal(progress.wrap.classList.contains("is-error"), true);
  assert.equal(progress.events.some(event => (
    event.type === "text" && event.id === "autoSortProgressPct" && event.value === "100%"
  )), false);
});

test("backend precheck sends the selected preset and expected-period contract", async () => {
  const data = makeData(700);
  data.tkb = {L1:{thu2:{sang:Array.from({length:5000}, (_, index) => `Tiet-${index}`)}}};
  data.tkbSolverResult = {
    lessons:Array.from({length:5000}, (_, index) => ({classId:"L1", subject:`Mon-${index}`}))
  };
  data.tkbLessonTeachers = Object.fromEntries(
    Array.from({length:5000}, (_, index) => [`L1|thu2|sang|${index}`, "GV01"])
  );
  data.tkbLessonRooms = {large:"x".repeat(100_000)};
  data.tkbConstraints = {teacher:{GV01:{maxDays:6}}};
  data.tkbUserOff = {L1:{"thu2|sang|0":true}};
  let precheckRequest = null;
  let precheckHeaders = null;
  const fetchImpl = async (url, options = {}) => {
    if(String(url).endsWith("/api/health")){
      return jsonResponse({ok:true, api:"rust"});
    }
    if(String(url).endsWith("/api/solve-precheck")){
      precheckRequest = JSON.parse(options.body);
      precheckHeaders = options.headers;
      return jsonResponse({
        ok:true,
        classes:1,
        assignments:1,
        expectedPeriods:700,
        skippedUnknownClass:0,
        skippedNoPeriod:0
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  window.TKBAuthApi = {
    getAuthHeaders(extra){ return Object.assign({}, extra || {}, {Authorization:"Bearer node-test"}); }
  };

  assert.equal(await hooks.maybeRunBackendPrecheck(data, "balanced"), true);
  assert.ok(precheckRequest);
  assert.equal(precheckRequest.settings.ui_solver_preset, "balanced");
  assert.equal(precheckRequest.settings.auto_sort_mode, "teacher_session_opt");
  assert.equal(precheckRequest.settings.expected_scheduled_periods, 700);
  assert.equal(precheckHeaders.Authorization, "Bearer node-test");
  assert.deepEqual(
    Object.keys(precheckRequest.data).sort(),
    ["giaovien", "lop", "mon", "monhoc", "pccmMatrix", "tkbConstraints", "tkbUserOff"]
  );
  assert.equal(precheckRequest.data.tkb, undefined);
  assert.equal(precheckRequest.data.tkbSolverResult, undefined);
  assert.equal(precheckRequest.data.tkbLessonTeachers, undefined);
  assert.equal(precheckRequest.data.tkbLessonRooms, undefined);
  assert.ok(
    window.__TKB_BACKEND_PRECHECK_REQUEST_DEBUG.requestBytes < JSON.stringify(data).length * 0.25,
    "precheck must not serialize the large timetable and prior solver result"
  );
});

test("backend precheck blocks structurally empty solver input", async () => {
  const data = makeData(2);
  const fetchImpl = async (url) => {
    if(String(url).endsWith("/api/health")){
      return jsonResponse({ok:true, api:"rust"});
    }
    if(String(url).endsWith("/api/solve-precheck")){
      return jsonResponse({
        ok:true,
        classes:0,
        assignments:0,
        expectedPeriods:0,
        skippedUnknownClass:0,
        skippedNoPeriod:0
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);

  assert.equal(await hooks.maybeRunBackendPrecheck(data, "fast"), false);
  assert.match(window.__TKB_BACKEND_PRECHECK_BLOCK_MESSAGE, /Chưa thể sắp xếp/);
});

test("default fresh capacity flags skip the synchronous local scanner", async () => {
  const data = makeData(29);
  const {window, hooks} = loadBridge(data);
  let scannerCalls = 0;
  window.TKBConstraints = {
    teacherFixedOffCapacityWarnings(){
      scannerCalls += 1;
      throw new Error("default fresh Play must not call the local teacher scanner");
    },
    classFixedOffCapacityWarnings(){
      scannerCalls += 1;
      throw new Error("default fresh Play must not call the local class scanner");
    }
  };

  const plan = hooks.buildAutomaticAutoSortPlan(data, undefined, 0);
  assert.equal(plan.kind, "fresh_complete_first");
  assert.equal(plan.settings.ui_skip_capacity_precheck, true);
  assert.equal(plan.settings.ui_fast_auto_sort_no_capacity_precheck, true);

  const result = await hooks.confirmCapacityPrecheckBeforeSolve(plan.settings);
  assert.equal(scannerCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.capacityShortage, false);
  assert.equal(result.localScanSkipped, true);
  assert.equal(result.warning, "");
});

test("capacity precheck without skip flags still blocks a real shortage", async () => {
  const data = makeData(29);
  const {window, hooks} = loadBridge(data);
  let scannerCalls = 0;
  window.TKBConstraints = {
    teacherFixedOffCapacityWarnings(){
      scannerCalls += 1;
      return [{
        kind:"teacher.fixedOff.capacity",
        teacherId:"GV01",
        teacherName:"GV 01",
        required:12,
        capacity:11,
        shortage:1
      }];
    },
    classFixedOffCapacityWarnings(){
      scannerCalls += 1;
      return [{
        kind:"class.fixedOff.capacity",
        classId:"L001",
        className:"6/1",
        required:29,
        capacity:28,
        shortage:1
      }];
    }
  };

  const result = await hooks.confirmCapacityPrecheckBeforeSolve({
    ui_solver_preset:"balanced",
    require_complete_schedule:true
  });
  assert.ok(scannerCalls > 0);
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.capacityShortage, true);
  assert.equal(result.localScanSkipped, undefined);
  assert.match(result.blockingMessage, /6\/1/);
  assert.match(result.blockingMessage, /GV 01/);
});

test("cancel request uses the tracked backend wire job id", async () => {
  const data = makeData(2);
  let cancelBody = null;
  let cancelHeaders = null;
  const fetchImpl = async (url, options = {}) => {
    if(String(url).endsWith("/api/health")){
      return jsonResponse({ok:true, api:"rust"});
    }
    if(String(url).endsWith("/api/solve-cancel")){
      cancelBody = JSON.parse(options.body);
      cancelHeaders = options.headers;
      return jsonResponse({ok:true, cancelRequested:true, jobId:cancelBody.solve_run_id});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window} = loadBridge(data, fetchImpl);
  window.TKBAuthApi = {
    getAuthHeaders(extra){ return Object.assign({}, extra || {}, {Authorization:"Bearer node-test"}); }
  };
  window.__TKB_ACTIVE_BACKEND_JOB_ID = "ui-run:req:wire-123";

  const result = await window.TKBRustAPI.cancelBackendSolver();
  assert.equal(cancelBody.solve_run_id, "ui-run:req:wire-123");
  assert.equal(result.cancelRequested, true);
  assert.equal(cancelHeaders.Authorization, "Bearer node-test");
});

test("Stop cancels a tracked job even while it is waiting in FIFO", async () => {
  const data = makeData(2);
  let cancelledJob = "";
  const fetchImpl = async (url, options = {}) => {
    if(String(url).endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(String(url).endsWith("/api/solve-cancel")){
      cancelledJob = JSON.parse(options.body).solve_run_id;
      return jsonResponse({ok:true, cancelRequested:true, jobId:cancelledJob});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window} = loadBridge(data, fetchImpl);
  window.__TKB_ACTIVE_BACKEND_JOB_ID = "queued-wire-456";
  window.__TKB_SOLVE_BACKEND_POSTED = false;
  window.__TKB_SOLVE_QUEUE_WAITING = true;

  await window.requestStopAutoSort();
  assert.equal(cancelledJob, "queued-wire-456");
});

test("FIFO wait stays silent until an explicit six-worker ticket can run", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const startedAt = clock.now();
  let solverStateCalls = 0;
  let solvePosts = 0;
  const earlyRetryStateCalls = [];
  let solvePostedAt = 0;
  let backendReady = false;
  const admissionIds = [];
  const observedAuth = [];

  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")){
      return jsonResponse({ok:true, api:"rust"});
    }
    if(requestUrl.includes("/api/solver-state")){
      observedAuth.push(options.headers?.Authorization || "");
      solverStateCalls += 1;
      const ready = solverStateCalls > 8;
      if(ready) backendReady = true;
      return jsonResponse({
        busy:true,
        activeJobs:ready ? 0 : 1,
        maxConcurrent:3,
        minWorkersPerJob:2,
        maxWorkersPerJob:6,
        workerTokensAvailable:ready ? 6 : 3,
        queuedJobs:1,
        queue:[{jobId:admissionIds[0], position:1, desiredWorkers:6}]
      });
    }
    if(requestUrl.endsWith("/api/solve-data")){
      observedAuth.push(options.headers?.Authorization || "");
      solvePosts += 1;
      if(solvePosts > 1 && !backendReady) earlyRetryStateCalls.push(solverStateCalls);
      admissionIds.push(JSON.parse(options.body).settings.ui_solve_run_id);
      if(options.signal?.aborted){
        const err = new Error("request was aborted before POST");
        err.name = "AbortError";
        throw err;
      }
      if(!backendReady){
        return jsonResponse({
          ok:false,
          queued:true,
          kind:"solver_queued",
          error:"solver_queued",
          queuePosition:1,
          queuedJobs:1,
          retryAfterMs:700,
          requiredWorkers:6
        }, 202);
      }
      solvePostedAt = clock.now();
      return jsonResponse({
        ok:true,
        lessons:[],
        metrics:{scheduled_periods:0, expected_periods:2, unassigned_periods:2},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const {window, hooks} = loadBridge(data, fetchImpl, withoutAutomaticBackendResume(clock));
  window.TKBAuthApi = {
    getAuthHeaders(extra){ return Object.assign({}, extra || {}, {Authorization:"Bearer fifo-test"}); }
  };
  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    ui_client_timeout_reserve_ms:0,
    ui_solver_queue_timeout_ms:5_000,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    allow_cpsat_quality_improvement:false,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(solvePosts, 2);
  assert.deepEqual(
    earlyRetryStateCalls,
    [],
    `a six-worker queue head must not retry until the whole pool is free: ${JSON.stringify(earlyRetryStateCalls)}`
  );
  assert.equal(solverStateCalls, 9);
  assert.ok(admissionIds[0]);
  assert.equal(new Set(admissionIds).size, 1);
  assert.ok(observedAuth.length > 0);
  assert.ok(observedAuth.every(value => value === "Bearer fifo-test"));
  assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG.timeoutMs, 5000);
  assert.ok(
    solvePostedAt - startedAt > window.__TKB_RUST_LAST_REQUEST_DEBUG.timeoutMs,
    "queue wait should be able to exceed the client request timeout"
  );
});

test("server-owned solve posts once and polls the durable result", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let solvePosts = 0;
  let resultPolls = 0;
  let postedSettings = null;
  let wireJobId = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      postedSettings = JSON.parse(options.body).settings;
      wireJobId = postedSettings.ui_solve_run_id;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId:wireJobId,
        retryAfterMs:700,
        requiredWorkers:6
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      if(resultPolls === 1){
        return jsonResponse({
          ok:false,
          running:true,
          serverOwned:true,
          kind:"solver_running",
          jobId:wireJobId,
          retryAfterMs:700
        }, 202);
      }
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(solvePosts, 1);
  assert.equal(resultPolls, 2);
  assert.equal(postedSettings.ui_solver_fifo_admission, true);
  assert.equal(postedSettings.ui_solver_async_job, true);
  assert.equal(postedSettings.ui_schedule_fingerprint, hooks.durableScheduleFingerprint(data));
  assert.equal(postedSettings.ui_progress_budget_seconds, 30);
  assert.equal(postedSettings.ui_progress_run_index, 1);
  assert.ok(wireJobId);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(window.__TKB_ACTIVE_BACKEND_JOB_ID, "");
});

test("a 180-second server job keeps its result reserve after the FIFO deadline", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const startedAtMs = clock.now();
  let resultPolls = 0;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      const settings = JSON.parse(options.body).settings;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId:settings.ui_solve_run_id,
        startedAtMs,
        progressBudgetSeconds:180,
        retryAfterMs:700,
        requiredWorkers:6
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      if(clock.now() - startedAtMs < 181_000){
        return jsonResponse({
          ok:false,
          running:true,
          serverOwned:true,
          kind:"solver_running",
          startedAtMs,
          progressBudgetSeconds:180,
          retryAfterMs:700
        }, 202);
      }
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);

  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_custom_solve_duration_seconds:180,
    ui_client_timeout_reserve_ms:90_000,
    ui_solver_queue_timeout_ms:180_000,
    overall_time_limit_seconds:180,
    optimization_time_limit_seconds:180,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG.backendDeadlineMs, 180_000);
  assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG.timeoutMs, 270_000);
  assert.ok(resultPolls > 250, `expected polling past 180 seconds, got ${resultPolls}`);
  assert.ok(clock.now() - startedAtMs >= 181_000);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("automatic server result wait honors its explicit ten-second response reserve", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {hooks} = loadBridge(data, null, withoutAutomaticBackendResume(clock));
  const liveWait = hooks.serverOwnedResultWaitMs(190_000, {
    progressBudgetSeconds:180,
    startedAtMs:clock.now()
  });
  const reloadFallback = hooks.serverOwnedResultWaitMs(0, {
    progressBudgetSeconds:180,
    startedAtMs:clock.now()
  });

  assert.equal(liveWait, 190_000);
  assert.equal(reloadFallback, 270_000);
});

test("a simultaneous duplicate POST adopts and polls the canonical owner job", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const canonicalJobId = "canonical-owner-schedule-job";
  let requestedJobId = "";
  let solvePosts = 0;
  let resultPolls = 0;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      requestedJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      assert.notEqual(requestedJobId, canonicalJobId);
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_running",
        jobId:canonicalJobId,
        startedAtMs:clock.now() - 1_000,
        retryAfterMs:700,
        requiredWorkers:6
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      assert.equal(new URL(requestUrl).searchParams.get("jobId"), canonicalJobId);
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);

  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(solvePosts, 1);
  assert.equal(resultPolls, 1);
  assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG.deduplicatedServerJob, true);
  assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG.duplicateRequestJobId, requestedJobId);
  assert.equal(window.__TKB_RUST_LAST_REQUEST_DEBUG.serverJobId, canonicalJobId);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(window.__TKB_ACTIVE_BACKEND_JOB_ID, "");
});

test("a resumed owner job polls by id without reposting or recreating it", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const jobId = "owner-job-discovered-on-device-b";
  let solvePosts = 0;
  let resultPolls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      throw new Error("a resumed job must never be reposted");
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      assert.equal(new URL(requestUrl).searchParams.get("jobId"), jobId);
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, clock);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - 5_000,
    solverStartedAtMs:clock.now() - 4_000,
    discoveredFromOwnerState:true
  });

  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(solvePosts, 0);
  assert.equal(resultPolls, 1);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
});

test("reload resumes a job created by the same tab with GET polling only", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const jobId = "same-tab-job-before-reload";
  let solvePosts = 0;
  let resultPolls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      throw new Error("reload must never POST a locally-created pending job");
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      assert.equal(new URL(requestUrl).searchParams.get("jobId"), jobId);
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - 5_000,
    solverStartedAtMs:clock.now() - 4_000,
    discoveredFromOwnerState:false
  });
  window.__TKB_SERVER_JOB_RESUME_STARTED = true;

  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(solvePosts, 0);
  assert.equal(resultPolls, 1);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
});

test("reload without a known server job exits before any solve POST", async () => {
  const data = makeData(2);
  let networkCalls = 0;
  const fetchImpl = async url => {
    networkCalls += 1;
    throw new Error(`Unexpected network request: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  window.__TKB_SERVER_JOB_RESUME_STARTED = true;

  await assert.rejects(
    hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    error => error?.kind === "solver_resume_missing"
  );
  assert.equal(networkCalls, 0);
});

test("detached server jobs are shown as reconnecting instead of failed", () => {
  const data = makeData(2);
  const {hooks} = loadBridge(data, null, withoutAutomaticBackendResume(createFakeClock()));
  const error = new Error("Lượt xếp vẫn được giữ trên máy chủ và sẽ tự nối lại khi kết nối ổn định.");
  error.kind = "solver_result_transport_unavailable";
  error.keepPendingServerJob = true;

  const friendly = hooks.friendlySolveError(error);
  assert.equal(friendly.title, "Đang chờ kết nối lại");
  assert.equal(friendly.level, "warning");
  assert.equal(friendly.statusLevel, "info");
  assert.equal(friendly.progressLabel, "Nối lại");
  assert.doesNotMatch(`${friendly.title}: ${friendly.message}`, /Có lỗi khi sắp xếp/);
  assert.match(
    BRIDGE_SOURCE,
    /err\.kind = "solver_result_wait_timeout";[\s\S]*?err\.keepPendingServerJob = true;/,
    "a result wait timeout must preserve the durable job for automatic reconnect"
  );
});

test("iOS background elapsed time keeps the VPS job and reconnects without cancelling", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 1_000);
  let wireJobId = "";
  let resultPolls = 0;
  let cancelPosts = 0;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId:wireJobId,
        startedAtMs:clock.now(),
        progressBudgetSeconds:1,
        retryAfterMs:250
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      if(resultPolls === 1){
        // Mobile Safari freezes the page while another app is foregrounded;
        // server time advances but no browser timers run.
        clock.elapseWithoutTasks(20_000);
      }
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_running",
        jobId:wireJobId,
        startedAtMs:clock.now() - 20_000,
        progressBudgetSeconds:1,
        retryAfterMs:250
      }, 202);
    }
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:true,
        requestedJobActive:true,
        jobs:[{jobId:wireJobId, startedAtMs:clock.now() - 20_000, allocatedWorkers:6}],
        queue:[]
      });
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      return jsonResponse({ok:true, cancelRequested:true, jobId:wireJobId});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  let detachedError = null;

  await assert.rejects(
    hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_client_timeout_reserve_ms:0,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => {
      detachedError = err;
      return err?.kind === "solver_result_wait_timeout"
        && err?.keepPendingServerJob === true;
    }
  );

  assert.equal(cancelPosts, 0);
  assert.ok(resultPolls >= 1);
  assert.equal(hooks.readPendingBackendJob()?.jobId, wireJobId);
  assert.equal(hooks.friendlySolveError(detachedError).title, "Đang chờ kết nối lại");
  assert.equal(hooks.localSolveLifecycleActive(), false);

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
  assert.equal(cancelPosts, 0);
});

test("iOS pageshow during request unwind keeps a retry and applies the canonical VPS result", async () => {
  const {data, payload:serverPayload} = makeLargeApplyFixture(1, 2);
  const incumbentCell = {mon:String(data.mon[0].ten), gv:"GV01"};
  data.tkb = {
    L1:{thu2:{sang:[incumbentCell, "", "", "", ""], chieu:["", "", "", "", ""]}}
  };
  const clock = createFakeClock(1_700_000_000_000, 0);
  const jobId = "ios-pageshow-canonical-job";
  let solvePosts = 0;
  let cancelPosts = 0;
  let resultPolls = 0;
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:true,
        requestedJobResultReady:true,
        requestedJobActive:false,
        jobs:[],
        queue:[],
        completedJobs:[{
          jobId,
          serverOwned:true,
          scheduleFingerprint:"",
          completedAtMs:clock.now()
        }]
      });
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      assert.equal(new URL(requestUrl).searchParams.get("jobId"), jobId);
      return jsonResponse(serverPayload);
    }
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      throw new Error("resume must not submit a second solve");
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      throw new Error("backgrounding must not cancel the VPS job");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - 20_000,
    solverStartedAtMs:clock.now() - 18_000,
    progressBudgetSeconds:60
  });

  // pageshow fires before the suspended request's catch/finally has released
  // the UI lifecycle. The first reconnect attempt must leave another attempt
  // armed instead of consuming the only durable wakeup.
  window.__TKB_SOLVE_UI_BUSY = true;
  window.__TKB_RUST_SOLVER_RUNNING = true;
  hooks.schedulePendingBackendResume(0, 100);
  clock.advance(100);
  await Promise.resolve();
  assert.equal(hooks.readPendingBackendJob()?.jobId, jobId);
  assert.equal(clock.pendingTimers(), 1, "a retry must survive the still-active local lifecycle");

  const visibleBeforeResult = JSON.stringify(data.tkb);
  window.__TKB_SOLVE_UI_BUSY = false;
  window.__TKB_RUST_SOLVER_RUNNING = false;
  const applied = await hooks.resumePendingBackendJobOnLoad(0);

  assert.ok(applied);
  assert.equal(resultPolls, 1);
  assert.equal(solvePosts, 0);
  assert.equal(cancelPosts, 0);
  assert.notEqual(JSON.stringify(data.tkb), visibleBeforeResult);
  assert.equal(hooks.countScheduledLessons(data), 2);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
});

test("repeated iOS foreground wakeups share one immutable poll-only reattach", async () => {
  const {data, payload:serverPayload} = makeLargeApplyFixture(1, 2);
  const subject = data.mon[0].ten;
  const empty = () => ["", "", "", "", ""];
  data.tkb = {
    L1:{
      thu2:{sang:[subject, "", "", "", ""], chieu:empty()},
      thu3:{sang:[subject, "", "", "", ""], chieu:empty()}
    }
  };
  data.tkbLessonTeachers = {[`L1|${subject}`]:"GV01"};
  data.tkbLessonRooms = {[`L1|${subject}`]:"R1"};
  data.tkbConstraints = {teacher:{GV01:{maxDaysSessions:{maxDays:1}}}};

  const clock = createFakeClock(1_700_000_000_000, 0);
  const progress = createProgressDocument(clock);
  const documentListeners = new Map();
  const windowListeners = new Map();
  const addListener = (root, type, callback) => {
    const key = String(type);
    if(!root.has(key)) root.set(key, []);
    root.get(key).push(callback);
  };
  progress.document.hidden = false;
  progress.document.addEventListener = (type, callback) => addListener(documentListeners, type, callback);
  progress.document.removeEventListener = () => {};

  const jobId = "ios-single-flight-poll-only-job";
  let solvePosts = 0;
  let cancelPosts = 0;
  let stateCalls = 0;
  let resultPolls = 0;
  let visibleBefore = null;
  let resolveState;
  const stateResponse = new Promise(resolve => { resolveState = resolve; });
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      return await stateResponse;
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      assert.equal(new URL(requestUrl).searchParams.get("jobId"), jobId);
      assert.deepEqual(
        JSON.parse(JSON.stringify({
          tkb:data.tkb,
          tkbLessonTeachers:data.tkbLessonTeachers,
          tkbLessonRooms:data.tkbLessonRooms,
          tkbUserOff:data.tkbUserOff,
          tkbConstraints:data.tkbConstraints
        })),
        visibleBefore,
        "poll-only reattach must preserve the flexible timetable byte-for-byte until apply"
      );
      return jsonResponse(serverPayload);
    }
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      throw new Error("foreground reattach must not submit another solve");
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      throw new Error("foreground reattach must not cancel the canonical solve");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    document:progress.document,
    addEventListener(type, callback){ addListener(windowListeners, type, callback); },
    removeEventListener(){}
  }));

  let syncDefaultGroupCalls = 0;
  window.TKBConstraints = {
    get(){ return data.tkbConstraints; },
    validateAll(){ return []; },
    syncDefaultGroups(){
      syncDefaultGroupCalls += 1;
      data.tkb.L1.thu2.sang[0] = "mutated-by-pre-solve";
    }
  };
  const releaseProbe = JSON.parse(JSON.stringify(data));
  assert.ok(
    hooks.releaseConstraintViolatingLessons(releaseProbe) > 0,
    "the fixture must prove that an unguarded resume would release flexible lessons"
  );
  visibleBefore = JSON.parse(JSON.stringify({
    tkb:data.tkb,
    tkbLessonTeachers:data.tkbLessonTeachers,
    tkbLessonRooms:data.tkbLessonRooms,
    tkbUserOff:data.tkbUserOff,
    tkbConstraints:data.tkbConstraints
  }));
  const strippedRequest = hooks.dataForSolverRequest(data, {});
  assert.equal(strippedRequest.__tkbRequestStrippedSchedule, true);
  assert.equal(hooks.countScheduledLessons(strippedRequest), 0);
  assert.deepEqual(data.tkb, visibleBefore.tkb, "building a fixed-only request must not touch visible DATA");

  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - 20_000,
    solverStartedAtMs:clock.now() - 18_000,
    progressBudgetSeconds:60
  });
  assert.equal(documentListeners.get("visibilitychange")?.length, 1);
  assert.equal(windowListeners.get("pageshow")?.length, 1);
  documentListeners.get("visibilitychange")[0]();
  clock.advance(100);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stateCalls, 1);

  windowListeners.get("pageshow")[0]();
  clock.advance(100);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stateCalls, 1, "an in-flight visibility probe and pageshow must share one state request");

  resolveState(jsonResponse({
    ok:true,
    requestedJobServerOwned:true,
    requestedJobResultReady:true,
    requestedJobActive:false,
    jobs:[],
    queue:[],
    completedJobs:[{jobId, serverOwned:true, completedAtMs:clock.now()}]
  }));
  for(let attempt = 0; attempt < 80 && resultPolls === 0; attempt += 1){
    await new Promise(resolve => setImmediate(resolve));
  }
  for(let attempt = 0; attempt < 80 && hooks.readPendingBackendJob(); attempt += 1){
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.equal(hooks.countScheduledLessons(data), 2);
  assert.equal(stateCalls, 1);
  assert.equal(resultPolls, 1);
  assert.equal(solvePosts, 0);
  assert.equal(cancelPosts, 0);
  assert.equal(syncDefaultGroupCalls, 0);
  assert.equal(hooks.countScheduledLessons(data), 2);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
});

test("poll-only reattach survives the pending row disappearing during its state probe", async () => {
  const {data, payload:serverPayload} = makeLargeApplyFixture(1, 2);
  data.tkb = {
    L1:{thu2:{sang:[String(data.mon[0].ten), "", "", "", ""], chieu:["", "", "", "", ""]}}
  };
  const clock = createFakeClock(1_700_000_000_000, 0);
  const jobId = "ios-pending-row-race-job";
  let stateCalls = 0;
  let resultPolls = 0;
  let solvePosts = 0;
  let cancelPosts = 0;
  let resolveState;
  let markStateStarted;
  const stateStarted = new Promise(resolve => { markStateStarted = resolve; });
  const stateResponse = new Promise(resolve => { resolveState = resolve; });
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      markStateStarted();
      return await stateResponse;
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      assert.equal(new URL(requestUrl).searchParams.get("jobId"), jobId);
      return jsonResponse(serverPayload);
    }
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      throw new Error("reattach must not submit a replacement solve");
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      throw new Error("reattach must not cancel the canonical solve");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, clock);
  const fingerprint = hooks.durableScheduleFingerprint(data);
  hooks.writePendingBackendJob(jobId, fingerprint, {
    createdAt:clock.now() - 20_000,
    solverStartedAtMs:clock.now() - 15_000,
    progressBudgetSeconds:60
  });

  const resumed = hooks.resumePendingBackendJobOnLoad(0);
  await stateStarted;
  hooks.clearActiveBackendJobId(jobId);
  assert.equal(
    hooks.readPendingBackendJob()?.jobId,
    jobId,
    "the reattach lease must reject a late terminal clear from the old lifecycle"
  );
  assert.equal(hooks.isSettledBackendJob(jobId), false);

  // A late callback in another tab first marks the id settled and then removes
  // the shared row. The in-flight reattach must trust the authenticated server
  // state and continue from its immutable metadata rather than falling into
  // solver_resume_missing or starting a new solve.
  hooks.rememberSettledBackendJob(jobId);
  hooks.removePendingBackendJob(jobId);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
  resolveState(jsonResponse({
    ok:true,
    requestedJobServerOwned:true,
    requestedJobResultReady:true,
    requestedJobActive:false,
    jobs:[],
    queue:[],
    completedJobs:[{jobId, serverOwned:true, scheduleFingerprint:fingerprint, completedAtMs:clock.now()}]
  }));
  const applied = await resumed;

  assert.ok(applied);
  assert.equal(stateCalls, 1);
  assert.equal(resultPolls, 1);
  assert.equal(solvePosts, 0);
  assert.equal(cancelPosts, 0);
  assert.equal(hooks.countScheduledLessons(data), 2);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
});

test("a resumed incomplete result ends without solver_resume_missing or a duplicate solve", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const canonicalJobId = "ios-resume-incomplete-canonical";
  let resultPolls = 0;
  let solvePosts = 0;
  let cancelPosts = 0;
  const incomplete = {
    ok:false,
    kind:"no_complete_schedule_before_deadline",
    error:"Chưa đủ thời gian để hoàn tất.",
    lessons:[{classId:"L1", subject:"Toán", teacher:"GV01", day:2, session:"AM", period:1}],
    metrics:{scheduled_periods:1, expected_periods:2, unassigned_periods:1, hard_ok:true},
    validation:{hard_ok:true, violations:[]},
    solver:{runtime_settings:{}},
    unassignedLessons:[{classId:"L1", subject:"Toán", count:1}]
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:true,
        requestedJobResultReady:true,
        requestedJobActive:false,
        jobs:[],
        queue:[],
        completedJobs:[{jobId:canonicalJobId, serverOwned:true, completedAtMs:clock.now()}]
      });
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      assert.equal(new URL(requestUrl).searchParams.get("jobId"), canonicalJobId);
      return jsonResponse(incomplete, 422);
    }
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      throw new Error("an incomplete terminal reattach must not submit a duplicate solve");
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      return jsonResponse({ok:true, cancelRequested:true});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  hooks.writePendingBackendJob(canonicalJobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - 20_000,
    solverStartedAtMs:clock.now() - 18_000,
    progressBudgetSeconds:60
  });

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(resultPolls, 1);
  assert.equal(solvePosts, 0);
  assert.equal(cancelPosts, 0);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(canonicalJobId), true);
});

test("a long iOS suspension retains the pending id beyond the active solve clock", async () => {
  const {data, payload:finalPayload} = makeLargeApplyFixture(1, 2);
  data.tkb = {
    L1:{thu2:{sang:[String(data.mon[0].ten), "", "", "", ""], chieu:["", "", "", "", ""]}}
  };
  const clock = createFakeClock(1_700_000_000_000, 0);
  const jobId = "ios-long-suspension-retained-job";
  const oldAgeMs = 2_200_000; // beyond the old queue + active-job age fence
  let resultPolls = 0;
  let solvePosts = 0;
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:true,
        requestedJobResultReady:true,
        requestedJobActive:false,
        jobs:[],
        queue:[],
        completedJobs:[{jobId, serverOwned:true, completedAtMs:clock.now() - 1000}]
      });
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      return jsonResponse(finalPayload);
    }
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      throw new Error("a retained resume must never POST a new solve");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - oldAgeMs,
    solverStartedAtMs:clock.now() - oldAgeMs + 5_000,
    progressBudgetSeconds:60
  });
  assert.equal(hooks.readPendingBackendJob()?.jobId, jobId);

  assert.ok(await hooks.resumePendingBackendJobOnLoad(0));
  assert.equal(resultPolls, 1);
  assert.equal(solvePosts, 0);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("AbortError detaches without cancelling and can reconnect on the same page", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let cancelPosts = 0;
  let wireJobId = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId:wireJobId,
        retryAfterMs:700
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      const err = new Error("browser transport detached");
      err.name = "AbortError";
      throw err;
    }
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:true,
        requestedJobActive:true,
        jobs:[{jobId:wireJobId, allocatedWorkers:6}],
        queue:[]
      });
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      return jsonResponse({ok:true, cancelRequested:true, jobId:wireJobId});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  let detachedError = null;
  await assert.rejects(
    hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => {
      detachedError = err;
      return err?.kind === "client_timeout" && err?.keepPendingServerJob === true;
    }
  );
  assert.equal(cancelPosts, 0);
  assert.equal(hooks.readPendingBackendJob()?.jobId, wireJobId);
  assert.equal(hooks.friendlySolveError(detachedError).title, "Đang chờ kết nối lại");
  assert.equal(hooks.localSolveLifecycleActive(), false, "a remote pending id must not block its own reconnect");
  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
});

test("a failed POST transport preserves the stable job id for replay", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let solvePosts = 0;
  let wireJobId = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      throw new TypeError("Failed to fetch");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, withoutAutomaticBackendResume(clock));
  let detachedError = null;

  await assert.rejects(
    hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => {
      detachedError = err;
      return err?.kind === "solver_post_network_detached" && err?.keepPendingServerJob === true;
    }
  );

  assert.equal(solvePosts, 2);
  assert.ok(wireJobId);
  assert.equal(hooks.readPendingBackendJob()?.jobId, wireJobId);
  assert.equal(hooks.friendlySolveError(detachedError).title, "Đang chờ kết nối lại");
  assert.equal(hooks.localSolveLifecycleActive(), false);
});

test("a changed schedule rejects a completed stale result without applying it", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let cancelPosts = 0;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      const jobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({ok:false, running:true, serverOwned:true, kind:"solver_started", jobId}, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      data.tkb = {L1:{thu2:{sang:[{mon:"Toán", gv:"GV01"}, "", "", "", ""]}}};
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      return jsonResponse({ok:true, cancelRequested:true});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, withoutAutomaticBackendResume(clock));
  await assert.rejects(
    hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => err?.kind === "solver_stale_result"
  );
  assert.equal(cancelPosts, 0);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("a pre-existing fingerprint mismatch cancels the obsolete job before starting a new one", async () => {
  const data = makeData(2);
  let cancelledJob = "";
  let postedJob = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelledJob = JSON.parse(options.body).solve_run_id;
      return jsonResponse({ok:true, cancelRequested:true, jobId:cancelledJob});
    }
    if(requestUrl.endsWith("/api/solve-data")){
      postedJob = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl);
  hooks.writePendingBackendJob("obsolete-job", "v1:old-schedule");
  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);
  assert.equal(payload.ok, true);
  assert.equal(cancelledJob, "obsolete-job");
  assert.ok(postedJob);
  assert.notEqual(postedJob, "obsolete-job");
});

test("pending jobs are scoped by sid and can auto-resume after reload", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const progress = createProgressDocument(clock);
  let cancelledJob = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelledJob = JSON.parse(options.body).solve_run_id;
      return jsonResponse({ok:true, cancelRequested:true, jobId:cancelledJob});
    }
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:true,
        requestedJobActive:true,
        jobs:[{jobId:"job-school-b", allocatedWorkers:6}],
        queue:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    document:progress.document,
    location:{
      search:"?sid=school-a",
      href:"http://127.0.0.1:1010/pages/sapxep.html?sid=school-a"
    }
  }));
  hooks.writePendingBackendJob("job-school-a", "");
  assert.equal(progress.home.hidden, false);
  assert.equal(progress.home.disabled, true);
  window.location.search = "?sid=school-b";
  window.location.href = "http://127.0.0.1:1010/pages/sapxep.html?sid=school-b";
  hooks.writePendingBackendJob("job-school-b", "");
  assert.equal(hooks.readPendingBackendJob()?.jobId, "job-school-b");
  window.location.search = "?sid=school-a";
  assert.equal(hooks.readPendingBackendJob()?.jobId, "job-school-a");

  window.location.search = "?sid=school-b";
  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
  assert.equal(hooks.readPendingBackendJob()?.jobId, "job-school-b");

  hooks.writePendingBackendJob("stale-auto-resume", "v1:old-schedule");
  for(let hydrationAttempt = 0; hydrationAttempt < 6; hydrationAttempt += 1){
    assert.equal(await hooks.resumePendingBackendJobOnLoad(hydrationAttempt), false);
    assert.equal(hooks.readPendingBackendJob()?.jobId, "stale-auto-resume");
    assert.equal(progress.home.hidden, false);
    assert.equal(progress.home.disabled, true);
    assert.equal(cancelledJob, "");
  }

  assert.equal(await hooks.resumePendingBackendJobOnLoad(6), false);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(cancelledJob, "");
  assert.equal(progress.home.hidden, false);
  assert.equal(progress.home.disabled, false);
});

test("a pending server job locks Home in place immediately after reload", () => {
  const data = makeData(2);
  const localStorage = memoryStorage();
  const location = {
    search:"?sid=reload-school",
    href:"http://127.0.0.1:1010/pages/sapxep.html?sid=reload-school"
  };
  const initial = loadBridge(data, null, {localStorage, location});
  initial.hooks.writePendingBackendJob("reload-running-job", "");

  const progress = createProgressDocument();
  const reloaded = loadBridge(data, null, {
    localStorage,
    document:progress.document,
    location
  });
  assert.equal(reloaded.hooks.readPendingBackendJob()?.jobId, "reload-running-job");
  assert.equal(progress.home.hidden, false);
  assert.equal(progress.home.disabled, true);

  reloaded.hooks.removePendingBackendJob("reload-running-job");
  assert.equal(progress.home.hidden, false);
  assert.equal(progress.home.disabled, false);
});

test("pending jobs are isolated by login identity on the same school and browser", () => {
  const data = makeData(2);
  const localStorage = memoryStorage();
  const {window, hooks} = loadBridge(data, undefined, {
    localStorage,
    location:{
      search:"?sid=shared-school",
      pathname:"/pages/sapxep",
      href:"http://127.0.0.1:1010/pages/sapxep?sid=shared-school"
    },
    setTimeout(){ return 0; },
    clearTimeout(){}
  });
  let loginId = "admin-a";
  window.TKBAuth = {getSession:() => ({userId:loginId})};

  hooks.writePendingBackendJob("job-admin-a", "");
  assert.equal(hooks.readPendingBackendJob()?.jobId, "job-admin-a");

  loginId = "admin-b";
  assert.equal(hooks.readPendingBackendJob(), null);
  hooks.writePendingBackendJob("job-admin-b", "");
  assert.equal(hooks.readPendingBackendJob()?.jobId, "job-admin-b");

  loginId = "admin-a";
  assert.equal(hooks.readPendingBackendJob()?.jobId, "job-admin-a");
});

test("reload keeps a pending job until owner identity finishes hydrating on retry", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const localStorage = memoryStorage();
  const location = {
    search:"?sid=owner-hydration-school",
    pathname:"/pages/sapxep",
    href:"http://127.0.0.1:1010/pages/sapxep?sid=owner-hydration-school"
  };
  const jobId = "owner-hydration-running-job";
  const ownerId = "hydrated-owner";
  const firstPage = loadBridge(data, null, Object.assign({}, clock, {localStorage, location}));
  firstPage.window.TKBAuth = {getSession:() => ({userId:ownerId})};
  const fingerprint = firstPage.hooks.durableScheduleFingerprint(data);
  firstPage.hooks.writePendingBackendJob(jobId, fingerprint, {
    createdAt:clock.now() - 20_000,
    solverStartedAtMs:clock.now() - 12_000,
    uiStartedAtMs:clock.now() - 12_000,
    lastPercent:18,
    progressBudgetSeconds:120,
    progressRunIndex:2,
    localClickTimeline:false
  });
  assert.equal(firstPage.hooks.readPendingBackendJob()?.jobId, jobId);

  let stateCalls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      return jsonResponse({
        ok:true,
        requestedJobId:jobId,
        requestedJobServerOwned:true,
        requestedJobActive:true,
        jobs:[{
          jobId,
          serverOwned:true,
          createdAtMs:clock.now() - 20_000,
          startedAtMs:clock.now() - 12_000,
          scheduleFingerprint:fingerprint,
          progressBudgetSeconds:120,
          progressRunIndex:2
        }],
        queue:[],
        completedJobs:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const progress = createProgressDocument(clock);
  const reloaded = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    localStorage,
    location,
    document:progress.document
  }));
  assert.equal(reloaded.hooks.readPendingBackendJob(), null, "owner identity is intentionally unavailable at first");
  assert.equal(await reloaded.hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(stateCalls, 0);
  const storedBeforeIdentity = JSON.parse(localStorage.getItem("TKB_SERVER_SOLVER_JOB_V1") || "{}");
  assert.equal(
    Object.values(storedBeforeIdentity).some(item => item?.jobId === jobId),
    true,
    "identity hydration must not erase another owner-scoped pending entry"
  );
  assert.ok(clock.pendingTimers() > 0, "an early anonymous check must schedule an owner-identity retry");

  reloaded.window.TKBAuth = {getSession:() => ({userId:ownerId})};
  assert.equal(await reloaded.hooks.resumePendingBackendJobOnLoad(1), true);
  assert.equal(stateCalls, 1);
  assert.equal(reloaded.hooks.readPendingBackendJob()?.jobId, jobId);
  assert.equal(reloaded.window.__TKB_RUST_PROGRESS_STATE?.label, "12 giây");
  assert.equal(reloaded.window.__TKB_RUST_PROGRESS_STATE?.runIndex, 2);
  assert.match(progress.nodes.get("statusMsg").textContent, /nối lại/i);
});

test("reload defers a temporary schedule fingerprint mismatch until DATA hydration settles", async () => {
  const stableData = makeData(2);
  const hydratingData = makeData(1);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const localStorage = memoryStorage();
  const location = {
    search:"?sid=fingerprint-hydration-school",
    pathname:"/pages/sapxep",
    href:"http://127.0.0.1:1010/pages/sapxep?sid=fingerprint-hydration-school"
  };
  const jobId = "fingerprint-hydration-running-job";
  const ownerId = "fingerprint-owner";
  const firstPage = loadBridge(stableData, null, Object.assign({}, clock, {localStorage, location}));
  firstPage.window.TKBAuth = {getSession:() => ({userId:ownerId})};
  const stableFingerprint = firstPage.hooks.durableScheduleFingerprint(stableData);
  firstPage.hooks.writePendingBackendJob(jobId, stableFingerprint, {
    createdAt:clock.now() - 18_000,
    solverStartedAtMs:clock.now() - 10_000,
    uiStartedAtMs:clock.now() - 10_000,
    lastPercent:16,
    progressBudgetSeconds:120,
    progressRunIndex:2,
    localClickTimeline:false
  });

  let stateCalls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      return jsonResponse({
        ok:true,
        requestedJobId:jobId,
        requestedJobServerOwned:true,
        requestedJobActive:true,
        jobs:[{
          jobId,
          serverOwned:true,
          createdAtMs:clock.now() - 18_000,
          startedAtMs:clock.now() - 10_000,
          scheduleFingerprint:stableFingerprint,
          progressBudgetSeconds:120,
          progressRunIndex:2
        }],
        queue:[],
        completedJobs:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const progress = createProgressDocument(clock);
  const reloaded = loadBridge(hydratingData, fetchImpl, Object.assign({}, clock, {
    localStorage,
    location,
    document:progress.document
  }));
  reloaded.window.TKBAuth = {getSession:() => ({userId:ownerId})};
  assert.notEqual(reloaded.hooks.durableScheduleFingerprint(hydratingData), stableFingerprint);
  assert.equal(reloaded.hooks.readPendingBackendJob()?.jobId, jobId);

  assert.equal(await reloaded.hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(stateCalls, 0, "a transient local mismatch should wait for hydration before contacting the VPS");
  assert.equal(reloaded.hooks.readPendingBackendJob()?.jobId, jobId, "pending work must survive the first mismatch");
  assert.ok(clock.pendingTimers() > 0, "a temporary fingerprint mismatch must schedule a retry");

  Object.assign(hydratingData, JSON.parse(JSON.stringify(stableData)));
  assert.equal(reloaded.hooks.durableScheduleFingerprint(hydratingData), stableFingerprint);
  assert.equal(await reloaded.hooks.resumePendingBackendJobOnLoad(1), true);
  assert.equal(stateCalls, 1);
  assert.equal(reloaded.hooks.readPendingBackendJob()?.jobId, jobId);
  assert.equal(reloaded.window.__TKB_RUST_PROGRESS_STATE?.label, "10 giây");
  assert.equal(reloaded.window.__TKB_RUST_PROGRESS_STATE?.runIndex, 2);
  assert.match(progress.nodes.get("statusMsg").textContent, /nối lại/i);
});

test("blank anonymous browser checks the shared server job state without attaching unrelated work", async () => {
  const data = makeData(2);
  let stateCalls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      return jsonResponse({ok:true, jobs:[], queue:[], completedJobs:[]});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, {
    setTimeout(){ return 0; },
    clearTimeout(){}
  });

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(stateCalls, 1);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("blank authenticated browser keeps watching for a job admitted after its first owner-state check", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 0);
  let scheduleFingerprint = "";
  let stateCalls = 0;
  const runningJobId = "owner-running-after-preflight";
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      if(stateCalls === 1){
        return jsonResponse({ok:true, jobs:[], queue:[], completedJobs:[]});
      }
      return jsonResponse({
        ok:true,
        jobs:[{
          jobId:runningJobId,
          serverOwned:true,
          createdAtMs:clock.now() - 5_000,
          startedAtMs:clock.now() - 2_000,
          scheduleFingerprint
        }],
        queue:[],
        completedJobs:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  scheduleFingerprint = hooks.durableScheduleFingerprint(data);
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(stateCalls, 1);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.ok(clock.pendingTimers() > 0, "an empty valid owner state must leave a background discovery timer");

  clock.advance(2_000);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(stateCalls, 2);
  assert.equal(hooks.readPendingBackendJob()?.jobId, runningJobId);
  assert.equal(hooks.readPendingBackendJob()?.discoveredFromOwnerState, true);
});

test("blank authenticated browser auto-discovers the matching owner running job", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const localStorage = memoryStorage();
  const stateUrls = [];
  const stateAuth = [];
  let scheduleFingerprint = "";
  const runningJobId = "owner-running-from-vps";
  const startedAtMs = clock.now() - 12_000;
  const createdAtMs = clock.now() - 20_000;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateUrls.push(requestUrl);
      stateAuth.push(options.headers?.Authorization || "");
      return jsonResponse({
        ok:true,
        jobs:[{
          jobId:runningJobId,
          serverOwned:true,
          createdAtMs,
          startedAtMs,
          progressBudgetSeconds:180,
          progressRunIndex:2,
          scheduleFingerprint
        }],
        queue:[],
        completedJobs:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    localStorage,
    setTimeout(){ return 0; },
    clearTimeout(){}
  }));
  scheduleFingerprint = hooks.durableScheduleFingerprint(data);
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  window.TKBAuthApi = {
    getAuthHeaders(extra){ return Object.assign({}, extra || {}, {Authorization:"Bearer same-owner"}); }
  };
  assert.equal(hooks.readPendingBackendJob(), null);

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
  const pendingSeenByResume = hooks.readPendingBackendJob();
  assert.equal(pendingSeenByResume?.jobId, runningJobId);
  assert.equal(pendingSeenByResume?.scheduleFingerprint, scheduleFingerprint);
  assert.equal(pendingSeenByResume?.discoveredFromOwnerState, true);
  assert.equal(pendingSeenByResume?.createdAt, createdAtMs);
  assert.equal(pendingSeenByResume?.solverStartedAtMs, startedAtMs);
  assert.equal(pendingSeenByResume?.progressBudgetSeconds, 180);
  assert.equal(pendingSeenByResume?.progressRunIndex, 2);
  assert.equal(hooks.readPendingBackendJob()?.jobId, runningJobId);
  assert.equal(stateUrls.length, 1);
  assert.equal(stateUrls[0].endsWith("/api/solver-state"), true);
  assert.deepEqual(stateAuth, ["Bearer same-owner"]);
});

test("blank authenticated browser auto-discovers the matching owner queued job", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let scheduleFingerprint = "";
  const queuedJobId = "owner-queued-from-vps";
  const createdAtMs = clock.now() - 5_000;
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        jobs:[],
        queue:[{
          jobId:queuedJobId,
          serverOwned:true,
          position:1,
          createdAtMs,
          queuedAtMs:createdAtMs,
          scheduleFingerprint
        }],
        completedJobs:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    setTimeout(){ return 0; },
    clearTimeout(){}
  }));
  scheduleFingerprint = hooks.durableScheduleFingerprint(data);
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  assert.equal(hooks.readPendingBackendJob(), null);

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
  const resumedJobId = hooks.readPendingBackendJob()?.jobId || "";
  assert.equal(resumedJobId, queuedJobId);
  assert.equal(hooks.readPendingBackendJob()?.jobId, queuedJobId);
  assert.equal(hooks.readPendingBackendJob()?.scheduleFingerprint, scheduleFingerprint);
  assert.equal(hooks.readPendingBackendJob()?.discoveredFromOwnerState, true);
  assert.equal(hooks.readPendingBackendJob()?.solverStartedAtMs, 0);
});

test("blank authenticated browser recovers the newest matching completed owner job", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let scheduleFingerprint = "";
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        jobs:[],
        queue:[],
        completedJobs:[
          {
            jobId:"completed-older",
            serverOwned:true,
            createdAtMs:clock.now() - 30_000,
            completedAtMs:clock.now() - 10_000,
            scheduleFingerprint
          },
          {
            jobId:"completed-newest",
            serverOwned:true,
            createdAtMs:clock.now() - 20_000,
            completedAtMs:clock.now() - 1_000,
            scheduleFingerprint
          }
        ]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    setTimeout(){ return 0; },
    clearTimeout(){}
  }));
  scheduleFingerprint = hooks.durableScheduleFingerprint(data);
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  assert.equal(hooks.readPendingBackendJob(), null);

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
  const resumedJobId = hooks.readPendingBackendJob()?.jobId || "";
  assert.equal(resumedJobId, "completed-newest");
  assert.equal(hooks.readPendingBackendJob()?.jobId, "completed-newest");
  assert.equal(hooks.readPendingBackendJob()?.discoveredFromOwnerState, true);
});

test("F5 does not rediscover a completed job already consumed by this browser", async () => {
  const data = makeData(2);
  const localStorage = memoryStorage();
  const runtime = {
    localStorage,
    setTimeout(){ return 0; },
    clearTimeout(){}
  };
  const firstPage = loadBridge(data, null, runtime);
  firstPage.window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  const jobId = "completed-consumed-before-f5";
  const fingerprint = firstPage.hooks.durableScheduleFingerprint(data);
  firstPage.hooks.writePendingBackendJob(jobId, fingerprint);
  firstPage.hooks.clearActiveBackendJobId(jobId);

  assert.equal(firstPage.hooks.readPendingBackendJob(), null);
  assert.equal(firstPage.hooks.isSettledBackendJob(jobId), true);

  let resumeCalls = 0;
  let stateCalls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      return jsonResponse({
        ok:true,
        jobs:[],
        queue:[],
        completedJobs:[{
          jobId,
          serverOwned:true,
          createdAtMs:Date.now() - 5_000,
          completedAtMs:Date.now() - 1_000,
          scheduleFingerprint:fingerprint
        }]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const reloadedPage = loadBridge(data, fetchImpl, runtime);
  reloadedPage.window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  reloadedPage.window.sapXepTuDongAll = async () => { resumeCalls += 1; return null; };

  assert.equal(await reloadedPage.hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(stateCalls, 1);
  assert.equal(resumeCalls, 0);
  assert.equal(reloadedPage.hooks.readPendingBackendJob(), null);
});

test("authenticated cross-device discovery observes a same-sid mismatch without applying or cancelling", async () => {
  const data = makeData(2);
  const dataBefore = JSON.stringify(data);
  const progress = createProgressDocument();
  let cancelPosts = 0;
  let solvePosts = 0;
  let resultGets = 0;
  let resumeCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        jobs:[{
          jobId:"running-for-old-schedule",
          serverOwned:true,
          scheduleScope:"default",
          createdAtMs:Date.now() - 5_000,
          startedAtMs:Date.now() - 4_000,
          progressBudgetSeconds:180,
          scheduleFingerprint:"v1:old-schedule"
        }],
        queue:[{
          jobId:"queued-without-fingerprint",
          serverOwned:true,
          position:1,
          createdAtMs:Date.now() - 3_000,
          scheduleFingerprint:""
        }],
        completedJobs:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")){
      resultGets += 1;
      return jsonResponse({ok:true, metrics:{scheduled_periods:2, expected_periods:2}});
    }
    if(requestUrl.endsWith("/api/solve-data") || options.method === "POST"){
      solvePosts += 1;
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      return jsonResponse({ok:true, cancelRequested:true});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, {
    document:progress.document,
    location:{search:"?sid=default", pathname:"/pages/sapxep"},
    setTimeout(){ return 0; },
    clearTimeout(){}
  });
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  window.sapXepTuDongAll = async () => { resumeCalls += 1; return null; };

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(resumeCalls, 0);
  assert.equal(cancelPosts, 0);
  assert.equal(solvePosts, 0);
  assert.equal(resultGets, 1);
  assert.equal(JSON.stringify(data), dataBefore, "an observer must never apply the mismatched result");
  assert.match(progress.nodes.get("statusMsg").textContent, /thiết bị khác đã hoàn tất/);
  assert.equal(hooks.isSettledBackendJob("running-for-old-schedule"), true);
});

test("Stop on an observe-only device cancels the canonical owner job", async () => {
  const data = makeData(2);
  let cancelPosts = 0;
  let cancelBody = null;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      cancelBody = JSON.parse(options.body);
      return jsonResponse({ok:true, cancelRequested:true, jobId:"observe-stop-job"});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  hooks.writePendingBackendJob("observe-stop-job", "v1:other-input", {
    discoveredFromOwnerState:true,
    observeOnly:true
  });

  await window.requestStopAutoSort();

  assert.equal(cancelPosts, 1);
  assert.equal(cancelBody.solve_run_id, "observe-stop-job");
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob("observe-stop-job"), true);
  assert.equal(window.__TKB_ACTIVE_BACKEND_JOB_ID, "");
});

test("cross-device discovery prioritizes a matching running job over queued and completed jobs", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let scheduleFingerprint = "";
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        jobs:[{
          jobId:"priority-running",
          serverOwned:true,
          createdAtMs:clock.now() - 30_000,
          startedAtMs:clock.now() - 20_000,
          scheduleFingerprint
        }],
        queue:[{
          jobId:"priority-queued",
          serverOwned:true,
          position:1,
          createdAtMs:clock.now() - 10_000,
          scheduleFingerprint
        }],
        completedJobs:[{
          jobId:"priority-completed-newest",
          serverOwned:true,
          createdAtMs:clock.now() - 5_000,
          completedAtMs:clock.now() - 100,
          scheduleFingerprint
        }]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    setTimeout(){ return 0; },
    clearTimeout(){}
  }));
  scheduleFingerprint = hooks.durableScheduleFingerprint(data);
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};

  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), true);
  const resumedJobId = hooks.readPendingBackendJob()?.jobId || "";
  assert.equal(resumedJobId, "priority-running");
  assert.equal(hooks.readPendingBackendJob()?.jobId, "priority-running");
});

test("cross-device discovery skips cancelling work and recovers a matching completed result", () => {
  const data = makeData(2);
  const {hooks} = loadBridge(data, null, {
    setTimeout(){ return 0; },
    clearTimeout(){}
  });
  const scheduleFingerprint = hooks.durableScheduleFingerprint(data);
  const selected = hooks.selectDiscoverableBackendJob({
    ok:true,
    jobs:[{
      jobId:"running-being-cancelled",
      serverOwned:true,
      cancelRequested:true,
      createdAtMs:Date.now() - 3_000,
      startedAtMs:Date.now() - 2_000,
      scheduleFingerprint
    }],
    queue:[],
    completedJobs:[{
      jobId:"completed-matching-result",
      serverOwned:true,
      createdAtMs:Date.now() - 5_000,
      completedAtMs:Date.now() - 1_000,
      scheduleFingerprint
    }]
  }, data, Date.now());

  assert.equal(selected.job?.jobId, "completed-matching-result");
  assert.equal(selected.job?.kind, "completed");
  assert.equal(selected.staleJob, null);
});

test("manual Play attaches as an observer to a same-owner same-sid running job", async () => {
  const data = makeData(2);
  const fingerprint = (() => {
    const {hooks} = loadBridge(data, null, {
      location:{search:"?sid=default", pathname:"/pages/sapxep"}
    });
    return hooks.durableScheduleFingerprint(data);
  })();
  let stateCalls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      return jsonResponse({
        ok:true,
        jobs:[{
          jobId:"same-sid-running",
          serverOwned:true,
          scheduleScope:"default",
          scheduleFingerprint:"v1:other-input",
          createdAtMs:Date.now() - 5_000,
          startedAtMs:Date.now() - 4_000
        }],
        queue:[],
        completedJobs:[]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, {
    location:{search:"?sid=default", pathname:"/pages/sapxep"}
  });
  window.TKBAuth = {getSession:() => ({userId:"same-owner"})};
  const guard = await hooks.inspectExistingBackendJobForManualSolve(data);
  assert.equal(guard?.kind, "observe");
  assert.equal(guard?.job?.jobId, "same-sid-running");
  assert.equal(hooks.readPendingBackendJob()?.jobId, "same-sid-running");
  assert.equal(hooks.readPendingBackendJob()?.observeOnly, true);
  assert.equal(stateCalls, 1);
  assert.equal(hooks.backendScheduleScope(), "default");
  assert.notEqual(fingerprint, "");
});

test("durable server-job fingerprint covers demand, assignment, and constraints", () => {
  const data = makeData(2);
  const {hooks} = loadBridge(data);
  const initial = hooks.durableScheduleFingerprint(data);

  data.pccmTietMatrix["L1|Toán"] = 3;
  const demandChanged = hooks.durableScheduleFingerprint(data);
  assert.notEqual(demandChanged, initial);

  data.pccmMatrix["L1|Toán"] = "GV02";
  const assignmentChanged = hooks.durableScheduleFingerprint(data);
  assert.notEqual(assignmentChanged, demandChanged);

  data.tkbConstraints = {fixedOff:{class:{L1:{"thu2|sang|0":true}}}};
  const constraintChanged = hooks.durableScheduleFingerprint(data);
  assert.notEqual(constraintChanged, assignmentChanged);

  data.tkbConfig = {off:[{classId:"L1", day:2, session:"AM", period:2}]};
  const legacyFixedOffChanged = hooks.durableScheduleFingerprint(data);
  assert.notEqual(legacyFixedOffChanged, constraintChanged);
  assert.equal(hooks.durableScheduleFingerprintMatches(legacyFixedOffChanged, data), true);
});

test("durable fingerprint ignores reload-only default groups and mirrored class off locks", () => {
  const data = makeData(2);
  data.tkbUserOff = {L1:["thu2|sang|0"]};
  data.tkbConstraints = {
    version:"constraints-old",
    groups:{class:{}, teacher:{}, subject:{}, room:{}},
    fixedOff:{class:{}, teacher:{}, subject:{}, room:{}, subjectGroup:{}},
    teacher:{GV01:{maxPeriodsPerDay:4}},
    meta:{updatedAt:"2026-07-01T00:00:00.000Z"}
  };
  const {hooks} = loadBridge(data);
  const beforeReloadNormalization = hooks.durableScheduleFingerprint(data);

  data.tkbConstraints.version = "constraints-new";
  data.tkbConstraints.meta.defaultGroupsSig = "9|reload-only-cache-revision";
  data.tkbConstraints.meta.updatedAt = "2026-07-13T00:00:00.000Z";
  data.tkbConstraints.groups.class.all = {name:"Tất cả lớp", items:["L1"]};
  data.tkbConstraints.groups.class.khoi_10 = {name:"Khối 10", items:["L1"]};
  data.tkbConstraints.groups.teacher.all = {name:"Tất cả giáo viên", items:["GV01"]};
  data.tkbConstraints.groups.subject.all = {name:"Tất cả môn học", items:["Toán"]};
  data.tkbConstraints.groups.room.all = {name:"Tất cả phòng học", items:[]};
  data.tkbConstraints.fixedOff.class.L1 = {"thu2|sang|0":true};

  assert.equal(hooks.durableScheduleFingerprint(data), beforeReloadNormalization);

  data.tkbConstraints.fixedOff.class.L1["thu3|sang|1"] = true;
  assert.notEqual(hooks.durableScheduleFingerprint(data), beforeReloadNormalization);
});

test("closing and reopening keeps the same pending VPS job across derived reload normalization", async () => {
  const original = makeData(2);
  original.tkbUserOff = {L1:["thu2|sang|0"]};
  original.tkbConstraints = {
    groups:{class:{}, teacher:{}, subject:{}, room:{}},
    fixedOff:{class:{}, teacher:{}, subject:{}, room:{}, subjectGroup:{}},
    meta:{}
  };
  const localStorage = memoryStorage();
  const firstPage = loadBridge(original, null, {localStorage});
  const fingerprint = firstPage.hooks.durableScheduleFingerprint(original);
  firstPage.hooks.writePendingBackendJob("reload-vps-job", fingerprint, {
    createdAt:Date.now() - 20_000,
    solverStartedAtMs:Date.now() - 12_000
  });
  assert.equal(firstPage.hooks.isSettledBackendJob("reload-vps-job"), false);

  const reloadedData = JSON.parse(JSON.stringify(original));
  reloadedData.tkbConstraints.meta.defaultGroupsSig = "7|reload-cache-only";
  reloadedData.tkbConstraints.groups.class.all = {name:"Tất cả lớp", items:["L1"]};
  reloadedData.tkbConstraints.groups.class.khoi_10 = {name:"Khối 10", items:["L1"]};
  reloadedData.tkbConstraints.groups.teacher.all = {name:"Tất cả giáo viên", items:["GV01"]};
  reloadedData.tkbConstraints.groups.subject.all = {name:"Tất cả môn học", items:["Toán"]};
  reloadedData.tkbConstraints.fixedOff.class.L1 = {"thu2|sang|0":true};
  let cancelPosts = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:true,
        requestedJobActive:true,
        jobs:[{
          jobId:"reload-vps-job",
          serverOwned:true,
          createdAtMs:Date.now() - 20_000,
          startedAtMs:Date.now() - 12_000,
          scheduleFingerprint:fingerprint
        }],
        queue:[],
        completedJobs:[]
      });
    }
    if(requestUrl.includes("/api/solve-result")) throw detachedAbortError();
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      return jsonResponse({ok:true, cancelRequested:true});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const reloadedPage = loadBridge(reloadedData, fetchImpl, {
    localStorage,
    setTimeout(){ return 0; },
    clearTimeout(){}
  });
  assert.equal(await reloadedPage.hooks.resumePendingBackendJobOnLoad(0), true);
  const resumedJobId = reloadedPage.hooks.readPendingBackendJob()?.jobId || "";
  assert.equal(resumedJobId, "reload-vps-job");
  assert.equal(reloadedPage.hooks.isSettledBackendJob("reload-vps-job"), false);
  assert.equal(cancelPosts, 0);
});

test("temporary solve-result 503 keeps the durable job and reconnects", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let resultPolls = 0;
  let wireJobId = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId:wireJobId,
        startedAtMs:clock.now() - 2_000,
        retryAfterMs:700
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      if(resultPolls === 1) return jsonResponse({ok:false, error:"bad_gateway"}, 503);
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, clock);
  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(resultPolls, 2);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("solve-result auth loss detaches without deleting the pending job", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let wireJobId = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({ok:false, running:true, serverOwned:true, kind:"solver_started", jobId:wireJobId}, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      return jsonResponse({
        ok:false,
        kind:"auth_required",
        error:"auth_required",
        diagnostics:{reason:"session_expired_during_resume"}
      }, 401);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, clock);
  await assert.rejects(
    hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => err?.kind === "solver_result_auth_required"
      && err?.keepPendingServerJob === true
      && err?.payload?.diagnostics?.reason === "session_expired_during_resume"
  );
  assert.equal(hooks.readPendingBackendJob()?.jobId, wireJobId);
});

test("server-owned capacity 429 waits and reposts the same stable job id", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const wireJobIds = [];
  const postTimes = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      wireJobIds.push(JSON.parse(options.body).settings.ui_solve_run_id);
      postTimes.push(clock.now());
      if(wireJobIds.length === 1){
        return jsonResponse({
          ok:false,
          kind:"solver_server_job_capacity",
          error:"solver_server_job_capacity",
          retryAfterMs:700
        }, 429);
      }
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, clock);
  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(wireJobIds.length, 2);
  assert.equal(new Set(wireJobIds).size, 1);
  assert.ok(postTimes[1] - postTimes[0] >= 700);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("explicit Stop clears persistence even when the cancel response is lost", async () => {
  const data = makeData(2);
  let cancelPosts = 0;
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      throw new Error("cancel response lost");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  hooks.writePendingBackendJob("lost-cancel-job", hooks.durableScheduleFingerprint(data));

  await window.requestStopAutoSort();

  assert.equal(cancelPosts, 1);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.persistentAutoResumeSuppressionForScope(), true);
  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), false);
});

test("Stop suppression survives UI stop reset until a genuine manual solve intent", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const localStorage = memoryStorage();
  let stateCalls = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-cancel")){
      return jsonResponse({ok:true, cancelRequested:true, jobId:"stopped-on-page"});
    }
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      return jsonResponse({ok:true, requestedJobServerOwned:true, requestedJobActive:true});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const runtime = Object.assign({}, clock, {localStorage});
  const {window, hooks} = loadBridge(data, fetchImpl, runtime);
  hooks.writePendingBackendJob("stopped-on-page", hooks.durableScheduleFingerprint(data));

  await window.requestStopAutoSort();
  window.__AUTO_SORT_STOP_REQUESTED = false;
  hooks.writePendingBackendJob("late-pending-after-stop", hooks.durableScheduleFingerprint(data));

  assert.equal(window.__TKB_AUTO_RESUME_SUPPRESSED, true);
  assert.equal(hooks.persistentAutoResumeSuppressionForScope(), true);
  assert.equal(await hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(hooks.schedulePendingBackendResume(0, 100), false);
  assert.equal(stateCalls, 0);
  assert.equal(clock.pendingTimers(), 0);

  const reloaded = loadBridge(data, fetchImpl, runtime);
  assert.equal(reloaded.hooks.persistentAutoResumeSuppressionForScope(), true);
  assert.equal(reloaded.hooks.automaticBackendResumeSuppressed(), true);
  assert.equal(await reloaded.hooks.resumePendingBackendJobOnLoad(0), false);

  reloaded.window.__TKB_SERVER_JOB_RESUME_STARTED = true;
  assert.equal(reloaded.hooks.prepareManualSolveIntent(), false);
  assert.equal(reloaded.hooks.persistentAutoResumeSuppressionForScope(), true);

  reloaded.window.__TKB_SERVER_JOB_RESUME_STARTED = false;
  assert.equal(reloaded.hooks.prepareManualSolveIntent(), true);
  assert.equal(reloaded.hooks.persistentAutoResumeSuppressionForScope(), false);
  assert.equal(reloaded.window.__TKB_AUTO_RESUME_SUPPRESSED, false);
  assert.equal(reloaded.window.__AUTO_SORT_STOP_REQUESTED, false);
});

test("F5 cannot rediscover an explicitly stopped VPS job", async () => {
  const data = makeData(2);
  const localStorage = memoryStorage();
  const jobId = "stopped-before-f5";
  let fingerprint = "";
  const stopFetch = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-cancel")){
      assert.equal(JSON.parse(options.body).solve_run_id, jobId);
      return jsonResponse({ok:true, cancelRequested:true, jobId});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const quietRuntime = {
    localStorage,
    setTimeout(){ return 0; },
    clearTimeout(){}
  };
  const firstPage = loadBridge(data, stopFetch, quietRuntime);
  fingerprint = firstPage.hooks.durableScheduleFingerprint(data);
  firstPage.hooks.writePendingBackendJob(jobId, fingerprint);
  await firstPage.window.requestStopAutoSort();
  assert.equal(firstPage.hooks.isSettledBackendJob(jobId), true);
  assert.equal(firstPage.hooks.persistentAutoResumeSuppressionForScope(), true);

  let resumeCalls = 0;
  const reloadFetch = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        jobs:[{
          jobId,
          serverOwned:true,
          createdAtMs:Date.now() - 8_000,
          startedAtMs:Date.now() - 7_000,
          scheduleFingerprint:fingerprint
        }],
        queue:[],
        completedJobs:[]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const reloadedPage = loadBridge(data, reloadFetch, quietRuntime);
  reloadedPage.window.sapXepTuDongAll = async () => { resumeCalls += 1; return null; };

  assert.equal(reloadedPage.window.__TKB_AUTO_RESUME_SUPPRESSED, undefined);
  assert.equal(reloadedPage.hooks.automaticBackendResumeSuppressed(), true);
  assert.equal(await reloadedPage.hooks.resumePendingBackendJobOnLoad(0), false);
  assert.equal(resumeCalls, 0);
  assert.equal(reloadedPage.hooks.readPendingBackendJob(), null);
});

test("Stop while solver-state is in flight cannot race into automatic sorting", async () => {
  const data = makeData(2);
  let resolveState;
  let markStateStarted;
  const stateStarted = new Promise(resolve => { markStateStarted = resolve; });
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      markStateStarted();
      return new Promise(resolve => { resolveState = resolve; });
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      return jsonResponse({
        ok:true,
        cancelRequested:true,
        jobId:JSON.parse(options.body).solve_run_id
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, {
    setTimeout(){ return 0; },
    clearTimeout(){}
  });
  const jobId = "stop-during-state-await";
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));
  let resumeCalls = 0;
  window.sapXepTuDongAll = async () => { resumeCalls += 1; return null; };

  const resumePromise = hooks.resumePendingBackendJobOnLoad(0);
  await stateStarted;
  await window.requestStopAutoSort();
  resolveState(jsonResponse({
    ok:true,
    requestedJobServerOwned:true,
    requestedJobActive:true,
    jobs:[{jobId, serverOwned:true}],
    queue:[]
  }));

  assert.equal(await resumePromise, false);
  assert.equal(resumeCalls, 0);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
});

test("Stop before wire-job admission leaves no pending id for an F5 replay", async () => {
  const data = makeData(2);
  const clock = withoutAutomaticBackendResume(createFakeClock());
  let solvePosts = 0;
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      return jsonResponse({ok:false, kind:"unexpected_post"}, 500);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  window.__AUTO_SORT_STOP_REQUESTED = true;
  window.__TKB_AUTO_RESUME_SUPPRESSED = true;

  await assert.rejects(
    hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => err?.kind === "user_cancelled"
  );

  assert.equal(solvePosts, 0);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("Stop after the final response is fetched still wins before result handling", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let cancelPosts = 0;
  let wireJobId = "";
  let windowRef = null;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({ok:false, running:true, serverOwned:true, kind:"solver_started", jobId:wireJobId}, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      void windowRef.requestStopAutoSort();
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    if(requestUrl.endsWith("/api/solve-cancel")){
      cancelPosts += 1;
      return jsonResponse({ok:true, cancelRequested:true, jobId:wireJobId});
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const loaded = loadBridge(data, fetchImpl, clock);
  windowRef = loaded.window;
  await assert.rejects(
    loaded.hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => err?.kind === "user_cancelled"
  );
  await Promise.resolve();
  assert.equal(cancelPosts, 1);
  assert.equal(loaded.hooks.readPendingBackendJob(), null);
});

test("an unknown pending job after reload is detached instead of replayed", async () => {
  const data = makeData(2);
  let postedJobId = "";
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:false,
        requestedJobResultReady:false,
        requestedJobActive:false,
        requestedJobQueued:false,
        jobs:[],
        queue:[]
      });
    }
    if(requestUrl.endsWith("/api/solve-data")){
      postedJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl);
  const stableJobId = "reload-before-register";
  hooks.writePendingBackendJob(stableJobId, hooks.durableScheduleFingerprint(data));
  window.sapXepTuDongAll = () => hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(await hooks.resumePendingBackendJobOnLoad(3), false);
  assert.equal(postedJobId, "");
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(stableJobId), true);
});

test("an API restart cannot replay an old pending job or its stale clock", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        ok:true,
        requestedJobServerOwned:false,
        requestedJobResultReady:false,
        requestedJobActive:false,
        requestedJobQueued:false,
        jobs:[],
        queue:[]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  const jobId = "replay-after-server-restart";
  const oldStartedAt = clock.now() - (33 * 60 * 1000);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:oldStartedAt,
    solverStartedAtMs:oldStartedAt,
    uiStartedAtMs:oldStartedAt,
    lastPercent:92
  });
  let replayed = null;
  window.sapXepTuDongAll = () => {
    replayed = hooks.readPendingBackendJob();
    return Promise.resolve(null);
  };

  assert.equal(await hooks.resumePendingBackendJobOnLoad(3), false);
  assert.equal(replayed, null);
  assert.equal(hooks.readPendingBackendJob(), null);
  assert.equal(hooks.isSettledBackendJob(jobId), true);
});

test("Stop during server-owned polling stays a silent user cancellation", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let windowRef = null;
  let healthChecks = 0;
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")){
      healthChecks += 1;
      return jsonResponse({ok:true, api:"rust"});
    }
    if(requestUrl.endsWith("/api/solve-data")){
      const jobId = JSON.parse(options.body).settings.ui_solve_run_id;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_started",
        jobId,
        startedAtMs:clock.now(),
        retryAfterMs:100
      }, 202);
    }
    if(requestUrl.includes("/api/solve-result")){
      windowRef.__AUTO_SORT_STOP_REQUESTED = true;
      return jsonResponse({
        ok:false,
        running:true,
        serverOwned:true,
        kind:"solver_running",
        startedAtMs:clock.now(),
        retryAfterMs:100
      }, 202);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const loaded = loadBridge(data, fetchImpl, clock);
  windowRef = loaded.window;

  await assert.rejects(
    loaded.hooks.postSolve({
      solver_mode:"auto",
      auto_sort_mode:"fast",
      ui_solver_preset:"fast",
      ui_internal_allow_incomplete:true,
      ui_allow_short_backend_deadline:true,
      overall_time_limit_seconds:1,
      optimization_time_limit_seconds:1,
      ui_skip_pre_solve_constraint_release:true
    }, data),
    err => err?.kind === "user_cancelled"
  );
  assert.equal(healthChecks, 1);
});

test("resumed progress uses server start time and excludes earlier FIFO wait", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);
  const jobId = "progress-resume";
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - 120_000,
    solverStartedAtMs:clock.now() - 20_000
  });

  hooks.startProgressTicker({auto_sort_mode:"fast"}, data);

  assert.match(window.__TKB_RUST_PROGRESS_STATE.label, /20 giây/);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "20 giây");
});

test("live VPS stages stay in debug state while the visible label remains time-only", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const progress = createProgressDocument(clock);
  const {window, hooks} = loadBridge(data, null, Object.assign({}, clock, {
    document:progress.document
  }));
  const jobId = "live-progress-contract";
  const settings = {
    auto_sort_mode:"fast",
    overall_time_limit_seconds:120,
    backend_deadline_ms:120_000
  };

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker(settings, data);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));
  hooks.recordBackendJobStarted(jobId, clock.now(), {
    progressBudgetSeconds:120,
    progressRunIndex:1
  });
  clock.advance(30_000);
  hooks.tickEstimatedProgress();
  const budgetPercent = window.__TKB_RUST_PROGRESS_STATE.percent;
  assert.ok(budgetPercent >= 25 && budgetPercent < 70);

  const stages = [
    [1, "input:loaded"],
    [2, "teacher_session_opt:first_click_feasibility"],
    [3, "teacher_session_opt:attempt"],
    [4, "period:session_start"],
    [5, "teacher_session_opt:best"],
    [6, "teacher_session_opt:done"]
  ];
  for(const [sequence, stage] of stages){
    hooks.recordBackendLiveProgress({
      protocol:"tkb-reference-solver-progress-v1",
      stage,
      sequence,
      // Deliberately near the full budget: the event clock describes the real
      // backend stage, but must never masquerade as an exact solve percentage.
      elapsedMs:119_000
    });
    const state = window.__TKB_RUST_PROGRESS_STATE;
    assert.equal(state.backendProgressStage, stage);
    assert.equal(state.backendProgressSequence, sequence);
    assert.equal(state.backendProgressElapsedMs, 119_000);
    assert.equal(window.__TKB_RUST_LAST_LIVE_PROGRESS.stage, stage);
    assert.equal(state.label, "30 giây");
    assert.equal(state.percent, budgetPercent);
  }

  const accepted = Object.assign({}, window.__TKB_RUST_PROGRESS_STATE);
  const rejected = [
    {protocol:"wrong-progress-v1", stage:"teacher_session_opt:best", sequence:99, elapsedMs:120_000},
    {protocol:"tkb-reference-solver-progress-v1", stage:"<script>bad()</script>", sequence:100, elapsedMs:120_000},
    {protocol:"tkb-reference-solver-progress-v1", stage:"teacher_session_opt:attempt", sequence:0, elapsedMs:1},
    {protocol:"tkb-reference-solver-progress-v1", stage:"teacher_session_opt:attempt", sequence:6, elapsedMs:120_000},
    {protocol:"tkb-reference-solver-progress-v1", stage:"teacher_session_opt:attempt", sequence:5, elapsedMs:120_000}
  ];
  for(const snapshot of rejected) hooks.recordBackendLiveProgress(snapshot);

  const afterRejected = window.__TKB_RUST_PROGRESS_STATE;
  assert.equal(afterRejected.backendProgressStage, accepted.backendProgressStage);
  assert.equal(afterRejected.backendProgressSequence, accepted.backendProgressSequence);
  assert.equal(afterRejected.backendProgressElapsedMs, accepted.backendProgressElapsedMs);
  assert.equal(afterRejected.label, accepted.label);
  assert.equal(afterRejected.percent, accepted.percent);

  clock.advance(1_000);
  hooks.tickEstimatedProgress();
  const afterTick = window.__TKB_RUST_PROGRESS_STATE;
  assert.equal(afterTick.label, "31 giây");
  assert.ok(afterTick.percent >= budgetPercent, "a live stage update must never make the estimated ring regress");
  assert.ok(afterTick.percent < 70, "a backend elapsedMs near the budget must not jump the ring forward");
});

test("pending result and solver-state responses forward their latest VPS progress snapshot", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const jobId = "live-progress-wire-job";
  const runId = "live-progress-wire-run";
  let resultPolls = 0;
  let stateCalls = 0;
  const snapshots = {
    result:{
      protocol:"tkb-reference-solver-progress-v1",
      stage:"period:session_start",
      sequence:3,
      elapsedMs:8_000
    },
    requestedState:{
      protocol:"tkb-reference-solver-progress-v1",
      stage:"teacher_session_opt:best",
      sequence:4,
      elapsedMs:9_000
    },
    jobState:{
      protocol:"tkb-reference-solver-progress-v1",
      stage:"teacher_session_opt:done",
      sequence:5,
      elapsedMs:10_000
    }
  };
  const fetchImpl = async url => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solve-result")){
      resultPolls += 1;
      if(resultPolls === 1){
        return jsonResponse({
          ok:false,
          running:true,
          serverOwned:true,
          kind:"solver_running",
          jobId,
          startedAtMs:clock.now() - 8_000,
          progressBudgetSeconds:120,
          progressRunIndex:1,
          progress:snapshots.result,
          retryAfterMs:250
        }, 202);
      }
      return jsonResponse({ok:true, result:"ready"});
    }
    if(requestUrl.includes("/api/solver-state")){
      stateCalls += 1;
      const progressSnapshot = stateCalls === 1
        ? snapshots.requestedState
        : snapshots.jobState;
      return jsonResponse({
        ok:true,
        requestedJobId:jobId,
        requestedJobActive:true,
        requestedJobProgress:stateCalls === 1 ? progressSnapshot : null,
        jobs:[{
          jobId,
          startedAtMs:clock.now() - 10_000,
          progress:progressSnapshot
        }],
        queue:[],
        completedJobs:[]
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const progress = createProgressDocument(clock);
  const {window, hooks} = loadBridge(data, fetchImpl, Object.assign({}, clock, {
    document:progress.document
  }));
  hooks.cancelPendingBackendResume();
  window.__TKB_ACTIVE_SOLVE_RUN_ID = runId;
  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker({
    auto_sort_mode:"fast",
    overall_time_limit_seconds:120,
    backend_deadline_ms:120_000
  }, data);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));
  clock.advance(1_000);

  const response = await hooks.waitForServerOwnedSolverResult(
    "http://127.0.0.1:1010",
    jobId,
    runId,
    30_000,
    250,
    new AbortController().signal
  );
  assert.equal(response.status, 200);
  assert.equal(resultPolls, 2);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.backendProgressStage, snapshots.result.stage);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.backendProgressSequence, snapshots.result.sequence);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "8 giây");
  const percentAfterResultPoll = window.__TKB_RUST_PROGRESS_STATE.percent;

  await window.TKBRustAPI.backendSolverState(jobId);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.backendProgressStage, snapshots.requestedState.stage);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.backendProgressSequence, snapshots.requestedState.sequence);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "8 giây");
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent >= percentAfterResultPoll);

  await window.TKBRustAPI.backendSolverState(jobId);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.backendProgressStage, snapshots.jobState.stage);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.backendProgressSequence, snapshots.jobState.sequence);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "8 giây");
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent >= percentAfterResultPoll);
  assert.equal(stateCalls, 2);
});

test("all pending VPS response paths hand progress to the live-progress recorder", () => {
  const stateStart = BRIDGE_SOURCE.indexOf("async function backendSolverState");
  const stateEnd = BRIDGE_SOURCE.indexOf("function detachedServerJobError", stateStart);
  const stateBody = BRIDGE_SOURCE.slice(stateStart, stateEnd);
  assert.match(stateBody, /requestedJobProgress/);
  assert.match(stateBody, /\.progress/);
  assert.match(stateBody, /recordBackendLiveProgress/);

  const waitStart = BRIDGE_SOURCE.indexOf("async function waitForServerOwnedSolverResult");
  const waitEnd = BRIDGE_SOURCE.indexOf("async function cancelBackendSolver", waitStart);
  const waitBody = BRIDGE_SOURCE.slice(waitStart, waitEnd);
  assert.match(waitBody, /recordBackendLiveProgress\(pending\?\.progress\)/);

  const postStart = BRIDGE_SOURCE.indexOf("async function postSolve");
  const postEnd = BRIDGE_SOURCE.indexOf("async function solveWithRustApi", postStart);
  const postBody = BRIDGE_SOURCE.slice(postStart, postEnd);
  assert.match(postBody, /recordBackendLiveProgress\(queuedPayload\?\.progress\)/);
});

test("two browsers on one canonical server job converge from server start and budget", () => {
  const nowMs = 1_700_000_000_000;
  const serverStartedAtMs = nowMs - 4_000;
  const jobId = "canonical-progress-job";
  const settings = {
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    progress_estimate_seconds:120,
    overall_time_limit_seconds:120,
    backend_deadline_ms:120_000
  };

  function attachBrowser(lastPercent, localBudgetSeconds, preparationAgeMs){
    const data = makeData(2);
    const clock = createFakeClock(nowMs);
    const {window, hooks} = loadBridge(data, null, Object.assign({}, clock, {
      localStorage:memoryStorage()
    }));
    hooks.startProgressTicker(settings, data);
    hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
      createdAt:nowMs - 30_000,
      solverStartedAtMs:serverStartedAtMs,
      uiStartedAtMs:nowMs - preparationAgeMs,
      lastPercent,
      progressEstimateSeconds:localBudgetSeconds,
      progressBudgetSeconds:localBudgetSeconds,
      progressRunIndex:lastPercent > 50 ? 8 : 1
    });
    hooks.recordBackendJobStarted(jobId, serverStartedAtMs, {
      progressBudgetSeconds:120,
      progressRunIndex:3
    });
    hooks.tickEstimatedProgress();
    return Object.assign({}, window.__TKB_RUST_PROGRESS_STATE);
  }

  const desktop = attachBrowser(94, 30, 95_000);
  const phone = attachBrowser(24, 300, 8_000);

  assert.deepEqual(
    {
      percent:desktop.percent,
      label:desktop.label,
      phase:desktop.phase,
      budgetSeconds:desktop.budgetSeconds,
      runIndex:desktop.runIndex,
      serverStartedAtMs:desktop.serverStartedAtMs
    },
    {
      percent:phone.percent,
      label:phone.label,
      phase:phone.phase,
      budgetSeconds:phone.budgetSeconds,
      runIndex:phone.runIndex,
      serverStartedAtMs:phone.serverStartedAtMs
    }
  );
  assert.equal(desktop.label, "4 giây");
  assert.equal(desktop.phase, "running");
  assert.equal(desktop.budgetSeconds, 120);
  assert.equal(desktop.runIndex, 3);
  assert.ok(desktop.percent < 24, `canonical 4-second progress must replace stale 94%, got ${desktop.percent}`);
});

test("60-second and 120-second VPS budgets both move smoothly to 99 percent", () => {
  function canonicalProgress(budgetSeconds, elapsedSeconds){
    const data = makeData(2);
    const clock = createFakeClock(1_700_000_000_000);
    const {window, hooks} = loadBridge(data, null, Object.assign({}, clock, {
      localStorage:memoryStorage()
    }));
    const jobId = `linear-${budgetSeconds}-${elapsedSeconds}`;
    hooks.startProgressTicker({
      auto_sort_mode:"fast",
      overall_time_limit_seconds:budgetSeconds,
      backend_deadline_ms:budgetSeconds * 1000
    }, data);
    hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));
    hooks.recordBackendJobStarted(jobId, clock.now(), {
      progressBudgetSeconds:budgetSeconds,
      progressRunIndex:1
    });
    clock.advance(elapsedSeconds * 1000);
    hooks.tickEstimatedProgress();
    return window.__TKB_RUST_PROGRESS_STATE;
  }

  const sixtyHalf = canonicalProgress(60, 30);
  const oneTwentyHalf = canonicalProgress(120, 60);
  const sixtyDone = canonicalProgress(60, 60);
  const oneTwentyDone = canonicalProgress(120, 120);

  assert.equal(sixtyHalf.percent, oneTwentyHalf.percent);
  assert.ok(sixtyHalf.percent >= 55 && sixtyHalf.percent <= 57);
  assert.equal(sixtyDone.percent, 99);
  assert.equal(oneTwentyDone.percent, 99);
  assert.equal(sixtyDone.phase, "server_wait");
  assert.equal(oneTwentyDone.phase, "server_wait");
});

test("pre-admission preparation stays low before canonical running begins", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);
  const settings = {
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    progress_estimate_seconds:120,
    overall_time_limit_seconds:120,
    backend_deadline_ms:120_000
  };

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker(settings, data);
  clock.advance(95_000);
  hooks.tickEstimatedProgress();
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.phase, "preparing");
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "1:35");
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent <= 12);

  const jobId = "prepared-then-admitted";
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));
  hooks.recordBackendJobStarted(jobId, clock.now() - 4_000, {
    progressBudgetSeconds:120,
    progressRunIndex:1
  });

  assert.equal(window.__TKB_RUST_PROGRESS_STATE.phase, "running");
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "1:35");
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent >= 12);
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent < 20);
});

test("backend admission preserves a fresh click percent and advances smoothly from that anchor", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);
  const jobId = "smooth-first-admission";
  const settings = {
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    progress_estimate_seconds:60,
    overall_time_limit_seconds:60,
    backend_deadline_ms:60_000
  };

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker(settings, data);
  clock.advance(1_000);
  hooks.tickEstimatedProgress();
  const beforeAdmission = Object.assign({}, window.__TKB_RUST_PROGRESS_STATE);
  assert.equal(beforeAdmission.label, "1 giây");
  assert.ok(beforeAdmission.percent >= 4 && beforeAdmission.percent < 12);

  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));
  hooks.recordBackendJobStarted(jobId, clock.now(), {
    progressBudgetSeconds:60,
    progressRunIndex:1
  });
  const admitted = Object.assign({}, window.__TKB_RUST_PROGRESS_STATE);
  assert.equal(admitted.phase, "running");
  assert.equal(admitted.label, "1 giây");
  assert.equal(
    admitted.percent,
    beforeAdmission.percent,
    `VPS admission must not jump ${beforeAdmission.percent}% -> ${admitted.percent}% in the same visible second`
  );

  clock.advance(1_000);
  hooks.tickEstimatedProgress();
  const afterOneBackendSecond = Object.assign({}, window.__TKB_RUST_PROGRESS_STATE);
  assert.equal(afterOneBackendSecond.label, "2 giây");
  assert.ok(afterOneBackendSecond.percent > admitted.percent);
  assert.ok(
    afterOneBackendSecond.percent < 12,
    `the budget curve must grow from the admitted ${admitted.percent}% anchor, got ${afterOneBackendSecond.percent}%`
  );

  clock.advance(59_000);
  hooks.tickEstimatedProgress();
  const afterBudget = window.__TKB_RUST_PROGRESS_STATE;
  assert.equal(afterBudget.percent, 99);
  assert.equal(afterBudget.phase, "server_wait");
  assert.equal(afterBudget.label, "1:01");
});

test("reload prime restores pending progress and timer immediately without regressing", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const localStorage = memoryStorage();
  const runtime = Object.assign({}, clock, {
    localStorage,
    setTimeout(){ return 0; },
    clearTimeout(){}
  });
  const settings = {
    auto_sort_mode:"fast",
    ui_default_fresh_sort:true,
    progress_estimate_seconds:180,
    overall_time_limit_seconds:180
  };
  const initial = loadBridge(data, null, runtime);
  const jobId = "reload-progress-continuity";

  initial.hooks.primeAutoSortStartUi();
  initial.hooks.startProgressTicker(settings, data);
  initial.hooks.restartProgressForRetry(settings, data);
  initial.hooks.writePendingBackendJob(jobId, initial.hooks.durableScheduleFingerprint(data), {
    solverStartedAtMs:clock.now()
  });
  initial.hooks.recordBackendJobStarted(jobId, clock.now(), {
    progressBudgetSeconds:180,
    progressRunIndex:2
  });
  clock.advance(61_000);
  initial.hooks.tickEstimatedProgress();

  const beforeReload = initial.window.__TKB_RUST_PROGRESS_STATE;
  const storedBeforeReload = initial.hooks.readPendingBackendJob();
  assert.ok(beforeReload.percent > 3);
  assert.match(beforeReload.label, /1:01/);
  assert.equal(storedBeforeReload.uiStartedAtMs, clock.now() - 61_000);
  assert.equal(storedBeforeReload.lastPercent, beforeReload.percent);
  assert.equal(storedBeforeReload.progressEstimateSeconds, 180);
  assert.equal(storedBeforeReload.progressBudgetSeconds, 180);
  assert.equal(storedBeforeReload.progressRunIndex, 2);
  assert.equal(storedBeforeReload.localClickTimeline, true);
  assert.equal(beforeReload.label, "1:01");

  const reloaded = loadBridge(data, null, runtime);
  reloaded.window.__TKB_SERVER_JOB_RESUME_STARTED = true;
  reloaded.hooks.primeAutoSortStartUi();
  const primed = reloaded.window.__TKB_RUST_PROGRESS_STATE;
  assert.ok(primed.percent >= beforeReload.percent);
  assert.match(primed.label, /1:01/);
  assert.equal(primed.runIndex, 2);

  reloaded.hooks.startProgressTicker(settings, data);
  const resumed = reloaded.window.__TKB_RUST_PROGRESS_STATE;
  assert.ok(resumed.percent >= primed.percent);
  assert.match(resumed.label, /1:01/);
  assert.equal(resumed.runIndex, 2);
  assert.equal(reloaded.hooks.readPendingBackendJob()?.lastPercent, resumed.percent);
});

test("a fresh sort never inherits stale pending progress from a completed click", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const localStorage = memoryStorage();
  const runtime = Object.assign({}, clock, {
    localStorage,
    setTimeout(){ return 0; },
    clearTimeout(){}
  });
  const initial = loadBridge(data, null, runtime);
  initial.hooks.writePendingBackendJob("stale-finished-progress", initial.hooks.durableScheduleFingerprint(data), {
    solverStartedAtMs:clock.now() - 61_000,
    uiStartedAtMs:clock.now() - 61_000,
    lastPercent:38,
    progressEstimateSeconds:180,
    progressBudgetSeconds:180
  });

  const fresh = loadBridge(data, null, runtime);
  fresh.hooks.primeAutoSortStartUi();
  clock.advance(1_000);
  fresh.hooks.tickEstimatedProgress();

  assert.ok(fresh.window.__TKB_RUST_PROGRESS_STATE.percent > 3);
  assert.match(fresh.window.__TKB_RUST_PROGRESS_STATE.label, /1 gi.y/);
  assert.doesNotMatch(fresh.window.__TKB_RUST_PROGRESS_STATE.label, /1:01/);
});

test("routine sorting status remains visible after the time-only progress label", () => {
  const data = makeData(2);
  const progress = createProgressDocument();
  const {window, hooks} = loadBridge(data, null, {document:progress.document});
  const status = progress.nodes.get("statusMsg");

  hooks.writeStatus("Đang sắp xếp.", "info");
  assert.equal(status.textContent, "Đang sắp xếp.");
  assert.notEqual(status.style.display, "none");

  window.__TKB_SERVER_JOB_RESUME_STARTED = true;
  hooks.setStatus("Đang sắp xếp...", "info");
  assert.equal(status.textContent, "Đang sắp xếp...");
  assert.notEqual(status.style.display, "none");

  const feedbackStart = PLANNER_HTML.indexOf('<div class="toolbar-feedback"');
  const feedbackEnd = PLANNER_HTML.indexOf('<div class="toolbar-secondary-actions"', feedbackStart);
  const feedbackMarkup = PLANNER_HTML.slice(feedbackStart, feedbackEnd);
  assert.ok(feedbackStart >= 0 && feedbackEnd > feedbackStart);
  assert.ok(feedbackMarkup.indexOf('id="autoSortProgress"') < feedbackMarkup.indexOf('id="statusMsg"'));
  assert.doesNotMatch(
    PLANNER_HTML,
    /#statusMsg\.is-auto-sort-running-label\s*\{[^}]*display\s*:\s*none/,
    "responsive CSS must not hide Đang sắp xếp after the progress time"
  );

  hooks.writeStatus("Thiếu ô xếp", "warning");
  assert.equal(status.classList.contains("is-auto-sort-running-label"), false);
  assert.equal(status.textContent, "Thiếu ô xếp");
});

test("queue and solver admission keep one continuous click timer and monotonic progress", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);
  const jobId = "continuous-progress-time";

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker({auto_sort_mode:"fast"}, data);
  clock.advance(2_000);
  hooks.tickEstimatedProgress();
  const beforeQueuePercent = window.__TKB_RUST_PROGRESS_STATE.percent;
  assert.match(window.__TKB_RUST_PROGRESS_STATE.label, /2 giây/);

  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));
  hooks.markBackendJobQueued(jobId);
  hooks.tickEstimatedProgress();
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "2 giây");
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent >= beforeQueuePercent);

  clock.advance(10_000);
  hooks.tickEstimatedProgress();
  const queuedPercent = window.__TKB_RUST_PROGRESS_STATE.percent;
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "12 giây");
  assert.ok(queuedPercent >= beforeQueuePercent);

  hooks.recordBackendJobStarted(jobId, clock.now());
  hooks.tickEstimatedProgress();
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "12 giây");
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent >= queuedPercent);
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.phase, "running");

  clock.advance(1_000);
  hooks.tickEstimatedProgress();
  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "13 giây");
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent > queuedPercent);
});

test("same-click API replay preserves the visible timer and progress floor", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);
  const jobId = "same-click-api-replay";

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker({auto_sort_mode:"fast"}, data);
  clock.advance(12_000);
  hooks.tickEstimatedProgress();
  const beforeReplay = Object.assign({}, window.__TKB_RUST_PROGRESS_STATE);
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data));

  const replayed = hooks.resetPendingBackendJobForReplay(jobId);
  hooks.tickEstimatedProgress();

  assert.equal(replayed.localClickTimeline, true);
  assert.equal(replayed.uiStartedAtMs, clock.now() - 12_000);
  assert.equal(replayed.lastPercent, beforeReplay.percent);
  assert.match(window.__TKB_RUST_PROGRESS_STATE.label, /12 gi.y/);
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent >= beforeReplay.percent);
});

test("server timestamps in Unix seconds cannot jump progress to the six-hour retention limit", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);

  hooks.primeAutoSortStartUi();
  hooks.startProgressTicker({auto_sort_mode:"fast"}, data);
  clock.advance(2_000);
  hooks.recordBackendJobStarted("seconds-from-older-server", Math.floor(clock.now() / 1_000));
  hooks.tickEstimatedProgress();

  assert.equal(window.__TKB_RUST_PROGRESS_STATE.label, "2 giây");
  assert.doesNotMatch(window.__TKB_RUST_PROGRESS_STATE.label, /360:00/);
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent < 20);
});

test("stale server timestamps preserve the local progress timer instead of clamping to six hours", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const {window, hooks} = loadBridge(data, null, clock);

  hooks.startProgressTicker({auto_sort_mode:"fast"}, data);
  clock.advance(2_000);
  hooks.recordBackendJobStarted("stale-server-clock", clock.now() - (7 * 60 * 60 * 1_000));
  hooks.tickEstimatedProgress();

  assert.match(window.__TKB_RUST_PROGRESS_STATE.label, /2 gi.y/);
  assert.doesNotMatch(window.__TKB_RUST_PROGRESS_STATE.label, /360:00/);
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent < 20);
});

test("a bad six-hour timestamp persisted by an older frontend is cleared before resume", () => {
  const data = makeData(2);
  const clock = createFakeClock();
  const localStorage = memoryStorage();
  const {window, hooks} = loadBridge(data, null, Object.assign({}, clock, {localStorage}));
  const jobId = "persisted-six-hour-boundary";
  hooks.writePendingBackendJob(jobId, hooks.durableScheduleFingerprint(data), {
    createdAt:clock.now() - 2_000
  });

  const storageKey = "TKB_SERVER_SOLVER_JOB_V1";
  const stored = JSON.parse(localStorage.getItem(storageKey));
  stored[hooks.backendJobStorageScope()].solverStartedAtMs = clock.now() - (6 * 60 * 60 * 1_000);
  localStorage.setItem(storageKey, JSON.stringify(stored));

  assert.equal(hooks.readPendingBackendJob()?.solverStartedAtMs, 0);
  hooks.startProgressTicker({auto_sort_mode:"fast"}, data);
  clock.advance(1_000);
  hooks.tickEstimatedProgress();
  assert.doesNotMatch(window.__TKB_RUST_PROGRESS_STATE.label, /360:00/);
  assert.ok(window.__TKB_RUST_PROGRESS_STATE.percent < 20);
});

test("offline pending jobs retain a low-frequency retry and online wakeup", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 0);
  const fetchImpl = async (url) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")) throw new Error("offline");
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl, clock);
  hooks.writePendingBackendJob("offline-resume", hooks.durableScheduleFingerprint(data));

  assert.equal(await hooks.resumePendingBackendJobOnLoad(6), false);
  assert.equal(hooks.readPendingBackendJob()?.jobId, "offline-resume");
  assert.equal(clock.pendingTimers(), 1);
  assert.match(BRIDGE_SOURCE, /addEventListener\?\.\("online"/);
});

test("FIFO fallback for an older server retries at the advertised cadence", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let solvePosts = 0;
  let firstPostAt = 0;
  let retryPostAt = 0;
  let wireJobId = "";

  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      return jsonResponse({
        busy:true,
        activeJobs:0,
        maxConcurrent:3,
        minWorkersPerJob:2,
        workerTokensAvailable:2,
        queuedJobs:1,
        queue:[{jobId:wireJobId, position:1}]
      });
    }
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      if(solvePosts === 1){
        firstPostAt = clock.now();
        return jsonResponse({
          ok:false,
          queued:true,
          kind:"solver_queued",
          error:"solver_queued",
          queuePosition:1,
          queuedJobs:1,
          retryAfterMs:700
        }, 202);
      }
      retryPostAt = clock.now();
      return jsonResponse({
        ok:true,
        lessons:[],
        metrics:{scheduled_periods:0, expected_periods:2, unassigned_periods:2},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const {hooks} = loadBridge(data, fetchImpl, clock);
  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    ui_client_timeout_reserve_ms:0,
    ui_solver_queue_timeout_ms:5_000,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    allow_cpsat_quality_improvement:false,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(solvePosts, 2);
  assert.ok(retryPostAt - firstPostAt >= 700, "legacy FIFO retry must sleep before reposting");
});

test("an already-running backend job is treated as a silent wait state", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let solvePosts = 0;
  let solverStateCalls = 0;
  let wireJobId = "";
  const earlyRetryStateCalls = [];

  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.includes("/api/solver-state")){
      solverStateCalls += 1;
      const running = solverStateCalls <= 4;
      return jsonResponse({
        ok:true,
        activeJobs:running ? 1 : 0,
        maxConcurrent:3,
        minWorkersPerJob:2,
        workerTokensAvailable:running ? 3 : 6,
        requestedJobActive:running,
        jobs:running ? [{jobId:wireJobId, allocatedWorkers:3}] : [],
        queue:[]
      });
    }
    if(requestUrl.endsWith("/api/solve-data")){
      solvePosts += 1;
      wireJobId = JSON.parse(options.body).settings.ui_solve_run_id;
      if(solvePosts > 1 && solverStateCalls <= 4) earlyRetryStateCalls.push(solverStateCalls);
      if(solvePosts === 1){
        return jsonResponse({
          ok:false,
          kind:"solver_job_already_running",
          error:"solver_job_already_running",
          jobId:wireJobId,
          retryAfterMs:700
        }, 409);
      }
      return jsonResponse({
        ok:true,
        lessons:[],
        metrics:{scheduled_periods:0, expected_periods:2, unassigned_periods:2},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    ui_client_timeout_reserve_ms:0,
    ui_solver_queue_timeout_ms:5_000,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    allow_cpsat_quality_improvement:false,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(solvePosts, 2);
  assert.equal(solverStateCalls, 5);
  assert.deepEqual(earlyRetryStateCalls, []);
  assert.notEqual(window.__TKB_SOLVER_LAST_ERROR_PAYLOAD?.error, "solver_job_already_running");
});

test("a cross-account job id conflict is cleared and retried silently with a new id", async () => {
  const data = makeData(2);
  const postedIds = [];
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")) return jsonResponse({ok:true, api:"rust"});
    if(requestUrl.endsWith("/api/solve-data")){
      const jobId = JSON.parse(options.body).settings.ui_solve_run_id;
      postedIds.push(jobId);
      if(postedIds.length === 1){
        return jsonResponse({
          ok:false,
          kind:"solver_job_id_conflict",
          error:"solver_job_id_conflict",
          jobId
        }, 409);
      }
      return jsonResponse({
        ok:true,
        lessons:[],
        unassignedLessons:[],
        metrics:{scheduled_periods:2, expected_periods:2, unassigned_periods:0, hard_ok:true},
        validation:{hard_ok:true},
        solver:{runtime_settings:{}}
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {hooks} = loadBridge(data, fetchImpl);
  hooks.writePendingBackendJob("foreign-owner-job", hooks.durableScheduleFingerprint(data));

  const payload = await hooks.postSolve({
    solver_mode:"auto",
    auto_sort_mode:"fast",
    ui_solver_preset:"fast",
    ui_internal_allow_incomplete:true,
    ui_allow_short_backend_deadline:true,
    overall_time_limit_seconds:1,
    optimization_time_limit_seconds:1,
    ui_skip_pre_solve_constraint_release:true
  }, data);

  assert.equal(payload.ok, true);
  assert.equal(postedIds.length, 2);
  assert.equal(postedIds[0], "foreign-owner-job");
  assert.notEqual(postedIds[1], postedIds[0]);
  assert.equal(hooks.readPendingBackendJob(), null);
});

test("server-owned result polling aborts a hung GET and continues with the same job", async () => {
  const data = makeData(2);
  const clock = createFakeClock(1_700_000_000_000, 10_000);
  let resultCalls = 0;
  let firstSignal = null;
  const fetchImpl = (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.includes("/api/solve-result")){
      resultCalls += 1;
      if(resultCalls === 1){
        firstSignal = options.signal;
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("poll timed out");
            error.name = "AbortError";
            reject(error);
          }, {once:true});
        });
      }
      return Promise.resolve(jsonResponse({ok:true, result:"ready"}));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const {window, hooks} = loadBridge(data, fetchImpl, clock);
  window.__TKB_ACTIVE_SOLVE_RUN_ID = "poll-run";
  hooks.writePendingBackendJob("poll-job", "");

  const response = await hooks.waitForServerOwnedSolverResult(
    "http://127.0.0.1:1010",
    "poll-job",
    "poll-run",
    30_000,
    700,
    new AbortController().signal
  );

  assert.equal(firstSignal.aborted, true);
  assert.equal(resultCalls, 2);
  assert.equal(response.status, 200);
  assert.equal(clock.pendingTimers(), 0);
});

test("backendSolverState aborts a hanging state request", async () => {
  const data = makeData(2);
  const clock = createFakeClock();
  let stateSignal = null;
  let markStateStarted;
  const stateStarted = new Promise((resolve) => { markStateStarted = resolve; });

  const fetchImpl = (url, options = {}) => {
    const requestUrl = String(url);
    if(requestUrl.endsWith("/api/health")){
      return Promise.resolve(jsonResponse({ok:true, api:"rust"}));
    }
    if(requestUrl.includes("/api/solver-state")){
      stateSignal = options.signal;
      markStateStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const err = new Error("state request timed out");
          err.name = "AbortError";
          reject(err);
        }, {once:true});
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const {window, hooks} = loadBridge(data, fetchImpl, withoutAutomaticBackendResume(clock));
  hooks.cancelPendingBackendResume();
  const statePromise = window.TKBRustAPI.backendSolverState();
  await stateStarted;

  assert.equal(stateSignal.aborted, false);
  clock.advance(2499);
  assert.equal(stateSignal.aborted, false);
  clock.advance(1);

  assert.equal(stateSignal.aborted, true);
  assert.equal(await statePromise, null);
  assert.equal(clock.pendingTimers(), 0);
});

test("completed schedules use one concise final notification while retaining quality state", () => {
  const v = (...points) => String.fromCodePoint(...points);
  const data = makeData(1566);
  const {hooks} = loadBridge(data);
  const payload = (teacherSessions, gap1) => ({
    metrics:{
      scheduled_periods:1566,
      expected_periods:1566,
      unassigned_periods:0,
      hard_ok:true,
      core_hard_ok:true,
      app_constraint_violation_count:0,
      teacher_sessions:teacherSessions,
      one_period_teacher_sessions:0,
      gap_distribution:{"0":Math.max(0, teacherSessions - gap1), "1":gap1}
    },
    validation:{hard_ok:true},
    solver:{runtime_settings:{}}
  });

  const poor = hooks.completionQualityStatus(payload(504, 55), data);
  assert.equal(poor.level, "warning");
  assert.equal(poor.progressLabel, v(0x43,0x1ea7,0x6e,0x20,0x74,0x1ed1,0x69,0x20,0x1b0,0x75));
  assert.equal(poor.message, v(0x0110,0x00e3,0x20,0x78,0x1ebf,0x70,0x20,0x78,0x6f,0x6e,0x67,0x21));
  assert.equal(poor.targetMet, false);

  const good = hooks.completionQualityStatus(payload(460, 30), data);
  assert.equal(good.level, "ok");
  assert.equal(good.targetMet, true);
  assert.equal(good.message, poor.message);
  const completeVisible = {scheduled:1566, expected:1566, unassigned:0};
  assert.equal(hooks.buildCompletionMessage(payload(504, 55), completeVisible), poor.message);
  assert.equal(hooks.buildCompletionMessage(payload(460, 30), completeVisible), poor.message);

  const retained = hooks.noBetterScheduleStatus(payload(504, 55));
  assert.equal(retained, poor.message);

  const small = makeData(2);
  const subject = small.mon[0].ten;
  small.tkb = {L1:{thu2:{sang:[subject, subject, "", "", ""], chieu:["", "", "", "", ""]}}};
  small.tkbSolverResult = payload(504, 55);
  small.tkbSolverResult.metrics.scheduled_periods = 2;
  small.tkbSolverResult.metrics.expected_periods = 2;
  const smallBridge = loadBridge(small);
  const friendly = smallBridge.hooks.friendlySolveError(Object.assign(new Error("expired"), {kind:"client_timeout"}));
  assert.equal(friendly.progressLabel, v(0x47,0x69,0x1eef,0x20,0x6c,0x1ecb,0x63,0x68));
  assert.equal(friendly.statusLevel, "warning");
  assert.equal(friendly.statusMessage, poor.message);
});
