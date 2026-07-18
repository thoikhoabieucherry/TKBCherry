"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function parseArgs(argv){
  const out = {};
  for(let i = 2; i < argv.length; i += 1){
    const key = String(argv[i] || "");
    if(!key.startsWith("--")) continue;
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

function memoryStorage(){
  const values = new Map();
  return {
    getItem(key){ return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value){ values.set(String(key), String(value)); },
    removeItem(key){ values.delete(String(key)); },
    clear(){ values.clear(); }
  };
}

function loadBridge(data, hardwareConcurrency){
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const document = {
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
    navigator: {hardwareConcurrency},
    location: {
      protocol: "http:",
      hostname: "127.0.0.1",
      origin: "http://127.0.0.1:1010",
      href: "http://127.0.0.1:1010/pages/sapxep.html",
      search: ""
    },
    setTimeout,
    clearTimeout,
    setInterval(){ return 0; },
    clearInterval(){},
    requestAnimationFrame(callback){ return setTimeout(callback, 0); },
    requestIdleCallback(callback){ return setTimeout(callback, 0); },
    confirm(){ return true; },
    alert(){},
    console
  };
  window.window = window;
  const context = vm.createContext({
    window,
    document,
    localStorage,
    sessionStorage,
    navigator: window.navigator,
    location: window.location,
    console,
    URLSearchParams,
    AbortController,
    Date,
    setTimeout,
    clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    fetch: async () => { throw new Error("Benchmark planner must not access the network"); },
    DAYS: ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"],
    SANG: 5,
    CHIEU: 5
  });
  const bridgePath = path.resolve(__dirname, "..", "web", "pages", "tkb-rust-bridge.js");
  const bridgeSource = fs.readFileSync(bridgePath, "utf8");
  const benchmarkExport = `
    window.__TKB_UNIFIED_BENCHMARK_FINALIZE = function(inputSettings, inputData){
      const effectiveSettings = effectiveSettingsForSolve(inputSettings, inputData);
      enforceCompleteScheduleForUi(effectiveSettings);
      enforceCompletePresetSolveSettings(effectiveSettings);
      clearPostRollbackSettings(effectiveSettings);
      const partialState = applyPartialExistingRepairSettings(
        effectiveSettings,
        inputData,
        "few_unassigned_before_post"
      );
      if(partialState){
        effectiveSettings.optimize_existing_schedule = effectiveSettings.ui_unified_partial_repair !== true;
        effectiveSettings.existing_fill_missing_schedule = true;
        effectiveSettings.force_fresh_backend_solve = true;
        effectiveSettings.best_effort_on_timeout = true;
      }
      effectiveSettings.force_fresh_backend_solve = true;
      effectiveSettings.solve_run_id = "benchmark-unified-wire";
      effectiveSettings.ui_solve_run_id = effectiveSettings.solve_run_id;
      effectiveSettings.ui_solver_fifo_admission = true;
      if(isNoHintSmartFreshSettings(effectiveSettings)) enforceNoHintFreshSolveSettings(effectiveSettings);
      const fixedLessonPreserveCount = applyFixedLessonPreserveSettings(effectiveSettings, inputData);
      if(isNoHintSmartFreshSettings(effectiveSettings)) enforceNoHintFreshSolveSettings(effectiveSettings);
      enforceCompletePresetSolveSettings(effectiveSettings);
      const allowShortBackendDeadline = effectiveSettings.ui_allow_short_backend_deadline === true;
      const capacityShortageSolve = isCapacityShortageAccepted(effectiveSettings);
      effectiveSettings.best_effort_on_timeout = allowShortBackendDeadline
        || effectiveSettings.ui_allow_best_effort_on_timeout === true
        || effectiveSettings.ui_staged_existing_repair === true
        || capacityShortageSolve;
      if(!allowShortBackendDeadline && !capacityShortageSolve){
        applySchedulingPressureTimeFloor(effectiveSettings, inputData);
      }
      if(!capacityShortageSolve) applyHeavyOnePeriodCleanupSettings(effectiveSettings, inputData);
      enforceRustRuntimeSafetySettings(effectiveSettings);
      if(isNoHintSmartFreshSettings(effectiveSettings)) enforceNoHintFreshSolveSettings(effectiveSettings);
      const overallSeconds = normalizeOverallTimeLimit(
        effectiveSettings.overall_time_limit_seconds ?? DEFAULT_SETTINGS.overall_time_limit_seconds
      );
      const optimizationSeconds = positiveNumberSetting(effectiveSettings.optimization_time_limit_seconds);
      const cpsatSeconds = positiveNumberSetting(effectiveSettings.native_cpsat_quality_time_limit_seconds)
        + positiveNumberSetting(effectiveSettings.native_cpsat_time_limit_seconds)
        + positiveNumberSetting(effectiveSettings.native_cpsat_lns_time_limit_seconds)
        + Math.ceil(positiveNumberSetting(effectiveSettings.native_cpsat_relaxed_hint_time_limit_ms) / 1000)
        + Math.ceil(positiveNumberSetting(effectiveSettings.native_cpsat_relaxed_hint_cleanup_ms) / 1000);
      const budgetSeconds = Math.max(overallSeconds, optimizationSeconds, cpsatSeconds);
      if(optimizationSeconds > overallSeconds){
        effectiveSettings.overall_time_limit_seconds = optimizationSeconds;
      }
      const minBackendDeadlineMs = allowShortBackendDeadline ? 1000 : 20000;
      const backendDeadlineMs = budgetSeconds > 0
        ? Math.max(minBackendDeadlineMs, Math.min(1800000, Math.round(budgetSeconds * 1000)))
        : 1800000;
      effectiveSettings.backend_deadline_ms = backendDeadlineMs;
      effectiveSettings.native_global_deadline_ms = backendDeadlineMs;
      effectiveSettings.native_deadline_reserve_ms = allowShortBackendDeadline
        ? Math.max(250, Math.min(1500, Number(effectiveSettings.native_deadline_reserve_ms || 500) || 500))
        : 1500;
      if(!allowShortBackendDeadline){
        alignNativeFreshToBackendDeadline(effectiveSettings, inputData, backendDeadlineMs);
      }
      applySolverPresetQualityPolicy(effectiveSettings);
      effectiveSettings.allow_strict_quality_solution_bank = false;
      if(isNoHintSmartFreshSettings(effectiveSettings)) enforceNoHintFreshSolveSettings(effectiveSettings);
      return {
        settings: effectiveSettings,
        data: dataForSolverRequest(inputData, effectiveSettings),
        partialState,
        fixedLessonPreserveCount
      };
    };
    window.__TKB_UNIFIED_BENCHMARK_INTERNALS = {
      stagedExistingRepairSettings,
      stagedExistingFreshRetrySettings
    };
  `;
  const closeIndex = bridgeSource.lastIndexOf("})();");
  if(closeIndex < 0) throw new Error("Cannot inject benchmark finalizer into bridge IIFE");
  const instrumentedSource = bridgeSource.slice(0, closeIndex) + benchmarkExport + bridgeSource.slice(closeIndex);
  vm.runInContext(instrumentedSource, context, {filename: bridgePath});
  if(!window.__TKB_RUST_BRIDGE_TEST_HOOKS) throw new Error("Bridge test hooks are unavailable");
  return {
    hooks: window.__TKB_RUST_BRIDGE_TEST_HOOKS,
    finalize: window.__TKB_UNIFIED_BENCHMARK_FINALIZE,
    internals: window.__TKB_UNIFIED_BENCHMARK_INTERNALS
  };
}

function emptyTimetable(){
  const out = {};
  for(const day of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
    out[day] = {sang: Array(5).fill(""), chieu: Array(5).fill("")};
  }
  return out;
}

function fixedCells(tkb){
  const out = [];
  for(const [classId, classTkb] of Object.entries(tkb || {})){
    for(const [day, dayValue] of Object.entries(classTkb || {})){
      for(const [session, cells] of Object.entries(dayValue || {})){
        if(!Array.isArray(cells)) continue;
        cells.forEach((value, index) => {
          if(value && typeof value === "object" && value.fixed === true){
            out.push({classId, day, session, index, value: JSON.parse(JSON.stringify(value))});
          }
        });
      }
    }
  }
  return out;
}

function subjectResolver(data){
  const aliases = new Map();
  for(const item of data.monhoc || []){
    const code = String(item?.ma || item?.ten || "").trim();
    for(const alias of [item?.ma, item?.ma2, item?.ten, item?.id]){
      const key = String(alias || "").trim().toLocaleLowerCase("vi");
      if(key && code) aliases.set(key, code);
    }
  }
  for(const item of data.mon || []){
    const code = String(item?.ten || item?.ma || "").trim();
    if(code) aliases.set(code.toLocaleLowerCase("vi"), code);
  }
  return value => {
    const raw = String(value || "").trim();
    return aliases.get(raw.toLocaleLowerCase("vi")) || raw;
  };
}

function compactIncumbentPayload(payload){
  const metrics = Object.assign({}, payload?.metrics || {});
  [
    "gap_sessions",
    "teacher_gap1_sessions",
    "teacher_gap_periods",
    "assignment_mismatches",
    "app_constraint_violations",
    "app_constraint_warnings",
    "class_session_violations",
    "contiguous_block_violations"
  ].forEach(key => delete metrics[key]);
  return {
    version: payload?.version,
    generatedAt: payload?.generatedAt,
    inputs: payload?.inputs || {},
    metrics,
    validation: payload?.validation || {},
    solver: payload?.solver || {},
    warnings: Array.isArray(payload?.warnings) ? payload.warnings.slice(0, 20) : [],
    unassignedLessons: Array.isArray(payload?.unassignedLessons)
      ? payload.unassignedLessons.slice(0, 80)
      : []
  };
}

function installIncumbent(data, payload, missingCount){
  const locks = fixedCells(data.tkb);
  const resolveSubject = subjectResolver(data);
  const tkb = {};
  const lessonTeachers = {};
  const lessonRooms = {};
  for(const cls of data.lop || []){
    const classId = String(cls?.id || cls?.ten || "").trim();
    if(classId) tkb[classId] = emptyTimetable();
  }
  const fixedKeys = new Set(locks.map(item => `${item.classId}|${item.day}|${item.session}|${item.index}`));
  const removable = [];
  for(const lesson of payload.lessons || []){
    const classId = String(lesson?.classId || "").trim();
    const day = `thu${Number(lesson?.day)}`;
    const session = String(lesson?.session || "").toUpperCase() === "PM" ? "chieu" : "sang";
    const index = Number(lesson?.period) - 1;
    const subject = resolveSubject(lesson?.subject);
    if(!classId || !tkb[classId] || !tkb[classId][day] || index < 0 || index >= 5) continue;
    tkb[classId][day][session][index] = subject;
    lessonTeachers[`${classId}|${subject}`] = String(lesson?.teacher || "").trim();
    lessonRooms[`${classId}|${subject}`] = String(lesson?.room || "").trim();
    const key = `${classId}|${day}|${session}|${index}`;
    if(!fixedKeys.has(key)) removable.push({classId, day, session, index, subject});
  }
  for(const lock of locks){
    if(!tkb[lock.classId]) tkb[lock.classId] = emptyTimetable();
    tkb[lock.classId][lock.day][lock.session][lock.index] = lock.value;
  }
  const removed = [];
  for(const item of removable.slice(0, Math.max(0, missingCount))){
    tkb[item.classId][item.day][item.session][item.index] = "";
    removed.push(item);
  }
  data.tkb = tkb;
  data.tkbLessonTeachers = lessonTeachers;
  data.tkbLessonRooms = lessonRooms;
  delete data.__tkbRequestFixedScheduleOnly;
  delete data.__tkbRequestStrippedSchedule;
  delete data.__tkbBackendStrippedSchedule;
  data.tkbSolverResult = compactIncumbentPayload(payload);
  return {fixedCount: locks.length, removed};
}

function setTeacherMaxDays(data, teacher, maxDays){
  const id = String(teacher || "").trim();
  const limit = Math.max(1, Math.round(Number(maxDays || 0) || 0));
  if(!id || !limit) return false;
  data.tkbConstraints = data.tkbConstraints && typeof data.tkbConstraints === "object"
    ? data.tkbConstraints
    : {};
  data.tkbConstraints.teacher = data.tkbConstraints.teacher && typeof data.tkbConstraints.teacher === "object"
    ? data.tkbConstraints.teacher
    : {};
  data.tkbConstraints.teacher[id] = {maxDaysSessions: {maxDays: limit}};
  return true;
}

function clearFlexibleTimetable(data){
  let cleared = 0;
  for(const classTkb of Object.values(data.tkb || {})){
    for(const dayValue of Object.values(classTkb || {})){
      for(const cells of Object.values(dayValue || {})){
        if(!Array.isArray(cells)) continue;
        for(let index = 0; index < cells.length; index += 1){
          const value = cells[index];
          if(!value || value === "OFF" || (typeof value === "object" && value.fixed === true)) continue;
          cells[index] = "";
          cleared += 1;
        }
      }
    }
  }
  data.tkbLessonTeachers = {};
  data.tkbLessonRooms = {};
  delete data.tkbSolverResult;
  delete data.tkbRustSolverResult;
  delete data.tkbSolverPayload;
  delete data.solverResult;
  delete data.solverMetrics;
  delete data.tkbOptimizationPlateau;
  return cleared;
}

function main(){
  const args = parseArgs(process.argv);
  if(!args.base || !args.output) throw new Error("Usage: --base request.json --output request.json [--lane fresh|refine|repair|constraint-repair|fresh-after-delete] [--incumbent response.json]");
  const lane = String(args.lane || "fresh").toLowerCase();
  const base = JSON.parse(fs.readFileSync(path.resolve(args.base), "utf8"));
  const data = JSON.parse(JSON.stringify(base.data || base || {}));
  let incumbentState = {fixedCount: fixedCells(data.tkb).length, removed: []};
  if(["refine", "repair", "constraint-repair", "fresh-after-delete"].includes(lane)){
    if(!args.incumbent) throw new Error(`${lane} requires --incumbent`);
    const response = JSON.parse(fs.readFileSync(path.resolve(args.incumbent), "utf8"));
    const payload = response.payload || response;
    incumbentState = installIncumbent(data, payload, lane === "repair" ? Number(args.missing || 4) : 0);
  }
  const teacherConstraintAdded = setTeacherMaxDays(data, args.teacher, args["max-days"]);
  if(lane === "constraint-repair" && !teacherConstraintAdded){
    throw new Error("constraint-repair requires --teacher and --max-days");
  }
  if(lane === "fresh-after-delete"){
    incumbentState.cleared = clearFlexibleTimetable(data);
  }
  const bridge = loadBridge(data, Number(args.hardware || 6));
  const hooks = bridge.hooks;
  let released = 0;
  let planned;
  let requestSettings;
  if(lane === "constraint-repair"){
    released = hooks.releaseConstraintViolatingLessons(data, {silent:true});
    const expected = hooks.expectedLessonCount(data);
    const preparedFreshPlan = hooks.buildFreshQualityAutoSortSettings(data, expected, "balanced");
    planned = hooks.buildConstraintRepairAutoSortPlan(data, expected, released, 0, preparedFreshPlan);
    requestSettings = String(args.phase || "fill").toLowerCase() === "fresh"
      ? bridge.internals.stagedExistingFreshRetrySettings(planned.settings, data, `benchmark-${lane}`)
      : bridge.internals.stagedExistingRepairSettings(planned.settings, planned.state, "fill", `benchmark-${lane}`);
  }else{
    planned = hooks.buildAutomaticAutoSortPlan(data);
    requestSettings = planned.settings;
  }
  const finalized = bridge.finalize(requestSettings, data);
  const settings = finalized.settings;
  if(args.workers) settings.num_workers = Math.max(1, Number(args.workers) || 1);
  if(args.seed && settings.random_seed != null) settings.random_seed = Number(args.seed);
  settings.solve_run_id = `benchmark-unified-${lane}-${Date.now()}`;
  const request = {data: finalized.data, settings};
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(request), "utf8");
  process.stdout.write(JSON.stringify({
    lane,
    planKind: planned.kind,
    state: planned.state,
    incumbentState,
    released,
    teacherConstraint: teacherConstraintAdded ? {teacher:args.teacher, maxDays:Number(args["max-days"])} : null,
    finalizer: {
      partialState: finalized.partialState,
      fixedLessonPreserveCount: finalized.fixedLessonPreserveCount
    },
    requestPath: path.resolve(args.output),
    settings: {
      auto_sort_mode: settings.auto_sort_mode,
      auto_sort_strategy: settings.auto_sort_strategy,
      ui_unified_solve_kind: settings.ui_unified_solve_kind,
      overall_time_limit_seconds: settings.overall_time_limit_seconds,
      optimization_time_limit_seconds: settings.optimization_time_limit_seconds,
      num_workers: settings.num_workers,
      preserve_existing_tkb: settings.preserve_existing_tkb,
      preserve_fixed_lessons_only: settings.preserve_fixed_lessons_only,
      repair_existing_missing_periods: settings.repair_existing_missing_periods,
      ui_use_existing_complete_incumbent: settings.ui_use_existing_complete_incumbent
    }
  }, null, 2));
}

module.exports = {
  clearFlexibleTimetable,
  fixedCells,
  installIncumbent,
  loadBridge,
  setTeacherMaxDays,
  subjectResolver
};

if(require.main === module) main();
