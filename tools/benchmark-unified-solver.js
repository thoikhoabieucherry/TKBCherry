"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  readJsonFileUtf8,
  runSolverRequest,
  validateCandidate,
  writeJsonFileUtf8
} = require("./solver-stdio-runner");

function parseArgs(argv){
  const out = {};
  for(let i = 2; i < argv.length; i += 1){
    const key = String(argv[i] || "");
    if(!key.startsWith("--")) continue;
    const next = argv[i + 1];
    if(next == null || String(next).startsWith("--")){
      out[key.slice(2)] = true;
      continue;
    }
    out[key.slice(2)] = next;
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
    window.__TKB_UNIFIED_BENCHMARK_FINALIZE = function(inputSettings, inputData, requestedRunId){
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
      effectiveSettings.solve_run_id = String(requestedRunId || "benchmark-unified-wire");
      effectiveSettings.ui_solve_run_id = effectiveSettings.solve_run_id;
      effectiveSettings.ui_solver_fifo_admission = true;
      effectiveSettings.ui_solver_async_job = true;
      if(isNoHintSmartFreshSettings(effectiveSettings)) enforceNoHintFreshSolveSettings(effectiveSettings);
      const fixedLessonPreserveCount = applyFixedLessonPreserveSettings(effectiveSettings, inputData);
      if(isNoHintSmartFreshSettings(effectiveSettings)) enforceNoHintFreshSolveSettings(effectiveSettings);
      enforceCompletePresetSolveSettings(effectiveSettings);
      applyCustomSolveDurationSettings(effectiveSettings);
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
      applyPartialExistingRepairSettings,
      buildConstraintRepairAutoSortPlan,
      buildFreshQualityAutoSortSettings,
      clearFreshOnlyFlags,
      countScheduledLessons,
      currentConstraintViolations,
      dataForSolverRequest,
      expectedLessonCount,
      partialExistingRepairState,
      restoreScheduleData,
      scheduleFingerprintFromData,
      shouldUseStagedExistingRepair,
      snapshotScheduleData,
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

function installIncumbent(data, payload, missingCount, options = {}){
  const locks = fixedCells(data.tkb);
  const resolveSubject = subjectResolver(data);
  const requestedMissingClass = String(options.missingClass || "").trim();
  const classById = new Map((data.lop || []).map(item => [
    String(item?.id || item?.ten || "").trim(),
    item || {}
  ]));
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
    if(!fixedKeys.has(key)){
      const classRow = classById.get(classId) || {};
      removable.push({
        classId,
        className:String(lesson?.className || classRow?.ten || classRow?.ten2 || classId),
        grade:String(lesson?.grade || classRow?.khoi || ""),
        day:Number(lesson?.day),
        dayKey:day,
        session:String(lesson?.session || "").toUpperCase() === "PM" ? "PM" : "AM",
        sessionKey:session,
        period:index + 1,
        index,
        subject,
        teacher:String(lesson?.teacher || "").trim(),
        room:String(lesson?.room || "").trim(),
        sourceCell:subject
      });
    }
  }
  for(const lock of locks){
    if(!tkb[lock.classId]) tkb[lock.classId] = emptyTimetable();
    tkb[lock.classId][lock.day][lock.session][lock.index] = lock.value;
  }
  const removed = [];
  const selectors = Array.isArray(options.missingCells) ? options.missingCells : [];
  const selectorKey = item => [
    String(item?.classId || requestedMissingClass || "").trim(),
    Number(item?.day || 0),
    String(item?.session || "").trim().toUpperCase(),
    Number(item?.period || 0)
  ].join("|");
  const requestedSelectorKeys = selectors.map(selectorKey);
  if(new Set(requestedSelectorKeys).size !== requestedSelectorKeys.length){
    throw new Error("--missing-cells contains a duplicate cell selector");
  }
  const removableBySelector = new Map(removable.map(item => [selectorKey(item), item]));
  const removablePool = selectors.length > 0
    ? selectors.map(selector => {
        const found = removableBySelector.get(selectorKey(selector));
        if(!found) throw new Error(`Requested removable cell was not found: ${selectorKey(selector)}`);
        return found;
      })
    : (requestedMissingClass
        ? removable.filter(item => item.classId === requestedMissingClass)
        : removable);
  const requestedMissing = Math.max(0, Math.round(Number(missingCount || 0) || 0));
  if(selectors.length > 0 && selectors.length !== requestedMissing){
    throw new Error(`Received ${selectors.length} missing-cell selectors for missing=${requestedMissing}`);
  }
  if(requestedMissingClass && removablePool.length < requestedMissing){
    throw new Error(
      `Class ${requestedMissingClass} has only ${removablePool.length} removable lessons; `
      + `${requestedMissing} were requested`
    );
  }
  for(const item of removablePool.slice(0, requestedMissing)){
    tkb[item.classId][item.dayKey][item.sessionKey][item.index] = "";
    removed.push(item);
  }
  data.tkb = tkb;
  data.tkbLessonTeachers = lessonTeachers;
  data.tkbLessonRooms = lessonRooms;
  delete data.__tkbRequestFixedScheduleOnly;
  delete data.__tkbRequestStrippedSchedule;
  delete data.__tkbBackendStrippedSchedule;
  const incumbentPayload = compactIncumbentPayload(payload);
  if(removed.length > 0){
    const removedKeys = new Set(removed.map(item => [
      item.classId,
      item.day,
      item.session,
      item.period
    ].join("|")));
    const retainedLessons = (payload.lessons || []).filter(lesson => !removedKeys.has([
      String(lesson?.classId || "").trim(),
      Number(lesson?.day),
      String(lesson?.session || "").trim().toUpperCase() === "PM" ? "PM" : "AM",
      Number(lesson?.period)
    ].join("|")));
    const expected = Math.max(
      retainedLessons.length + removed.length,
      Number(payload?.metrics?.expected_periods || 0) || 0
    );
    incumbentPayload.ok = false;
    incumbentPayload.bestEffort = true;
    incumbentPayload.lessons = cloneJson(retainedLessons);
    incumbentPayload.metrics = Object.assign({}, incumbentPayload.metrics || {}, {
      scheduled_periods:retainedLessons.length,
      expected_periods:expected,
      unassigned_periods:Math.max(0, expected - retainedLessons.length),
      accounted_periods:expected,
      complete_schedule:false,
      best_effort:true,
      hard_ok:false,
      core_hard_ok:false
    });
    incumbentPayload.validation = Object.assign({}, incumbentPayload.validation || {}, {
      hard_ok:false,
      placement_hard_ok:true
    });
    incumbentPayload.unassignedLessons = removed.map(item => ({
      classId:item.classId,
      className:item.className,
      grade:item.grade,
      subject:item.subject,
      teacher:item.teacher,
      room:item.room,
      count:1
    }));
  }
  data.tkbSolverResult = incumbentPayload;
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

function cloneJson(value){
  return JSON.parse(JSON.stringify(value));
}

function canonicalValue(value){
  if(Array.isArray(value)) return value.map(canonicalValue);
  if(value && typeof value === "object"){
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalHash(value){
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)), "utf8")
    .digest("hex");
}

function snapshotFields(value){
  const source = value || {};
  return {
    tkb:cloneJson(source.tkb || {}),
    tkbLessonTeachers:cloneJson(source.tkbLessonTeachers || {}),
    tkbLessonRooms:cloneJson(source.tkbLessonRooms || {}),
    tkbSolverResult:cloneJson(source.tkbSolverResult || null)
  };
}

function parseMissingCells(value, fallbackClassId){
  const text = String(value || "").trim();
  if(!text) return [];
  return text.split(",").map(part => {
    const fields = part.trim().split(":");
    const hasClass = fields.length === 4;
    const [classId, day, session, period] = hasClass
      ? fields
      : [fallbackClassId, ...fields];
    const parsed = {
      classId:String(classId || "").trim(),
      day:Number(day),
      session:String(session || "").trim().toUpperCase(),
      period:Number(period)
    };
    if(
      !parsed.classId
      || !Number.isInteger(parsed.day)
      || !["AM", "PM"].includes(parsed.session)
      || !Number.isInteger(parsed.period)
      || parsed.period < 1
      || parsed.period > 5
    ){
      throw new Error(`Invalid --missing-cells entry: ${part}`);
    }
    return parsed;
  });
}

function teacherForCell(data, classId, cell, resolveSubject){
  if(!cell || cell === "OFF") return "";
  if(typeof cell === "object"){
    const direct = String(cell.teacher || cell.giaovien || cell.gv || "").trim();
    if(direct) return direct;
  }
  const rawSubject = typeof cell === "object"
    ? (cell.mon || cell.subject || cell.ten || cell.name || "")
    : cell;
  const subject = resolveSubject(rawSubject);
  const keys = [
    `${classId}|${subject}`,
    `${classId}||${subject}`,
    `${classId}:${subject}`
  ];
  for(const map of [data.tkbLessonTeachers, data.pccmMatrix]){
    for(const key of keys){
      const value = String(map?.[key] || "").trim();
      if(value) return value;
    }
  }
  return "";
}

function benchmarkConstraintViolations(data){
  const rules = data?.tkbConstraints?.teacher;
  if(!rules || typeof rules !== "object") return [];
  const resolveSubject = subjectResolver(data);
  const daysByTeacher = new Map();
  for(const [classId, classTkb] of Object.entries(data.tkb || {})){
    for(const [dayKey, dayValue] of Object.entries(classTkb || {})){
      const day = Number(String(dayKey).replace(/\D+/g, ""));
      if(!Number.isInteger(day)) continue;
      for(const cells of Object.values(dayValue || {})){
        if(!Array.isArray(cells)) continue;
        for(const cell of cells){
          const teacher = teacherForCell(data, classId, cell, resolveSubject);
          if(!teacher) continue;
          if(!daysByTeacher.has(teacher)) daysByTeacher.set(teacher, new Set());
          daysByTeacher.get(teacher).add(day);
        }
      }
    }
  }
  const out = [];
  for(const [teacher, teacherRules] of Object.entries(rules)){
    const maxDays = Math.max(
      0,
      Number(teacherRules?.maxDaysSessions?.maxDays || teacherRules?.maxDays || 0) || 0
    );
    if(maxDays <= 0) continue;
    const days = [...(daysByTeacher.get(teacher) || [])].sort((a, b) => a - b);
    if(days.length > maxDays){
      out.push({
        kind:"teacher.maxDaysSessions",
        teacher,
        maxDays,
        actualDays:days.length,
        days
      });
    }
  }
  return out;
}

function requestCompletion(candidate){
  const metrics = candidate?.metrics || {};
  const scheduled = Math.max(0, Number(metrics.scheduled_periods || 0) || 0);
  const expected = Math.max(0, Number(metrics.expected_periods || 0) || 0);
  const unassigned = Math.max(0, Number(metrics.unassigned_periods || 0) || 0);
  const hardOk = metrics.hard_ok !== false
    && metrics.core_hard_ok !== false
    && candidate?.validation?.hard_ok !== false;
  return {
    scheduled,
    expected,
    unassigned,
    hardOk,
    complete:expected > 0 && scheduled >= expected && unassigned === 0 && hardOk
  };
}

function settingsSummary(settings){
  const keys = [
    "auto_sort_mode",
    "auto_sort_strategy",
    "ui_unified_solve_kind",
    "ui_constraint_change_repair",
    "ui_constraint_change_fresh_retry",
    "ui_constraint_change_rebuild_from_empty",
    "ui_skip_pre_solve_constraint_release",
    "ui_staged_existing_repair",
    "ui_staged_existing_phase",
    "ui_unified_partial_repair",
    "ui_preflight_constraint_violation_count",
    "overall_time_limit_seconds",
    "optimization_time_limit_seconds",
    "backend_deadline_ms",
    "num_workers",
    "preserve_existing_tkb",
    "preserve_fixed_lessons_only",
    "existing_fill_missing_schedule",
    "existing_scheduled_periods",
    "existing_flexible_scheduled_periods",
    "expected_scheduled_periods",
    "repair_existing_missing_periods",
    "repair_fill_first_max_missing",
    "allow_solver_warm_start",
    "require_complete_schedule"
  ];
  return keys.reduce((out, key) => {
    if(Object.prototype.hasOwnProperty.call(settings || {}, key)) out[key] = settings[key];
    return out;
  }, {});
}

function buildPartialRepairPlan(bridge, data, planned, ceilingSeconds){
  const settings = Object.assign({}, planned.settings || {});
  bridge.internals.clearFreshOnlyFlags(settings);
  settings.ui_unified_auto_sort = true;
  settings.ui_unified_solve_kind = "repair_partial";
  settings.ui_unified_partial_repair = true;
  settings.ui_default_fresh_sort = false;
  settings.ui_allow_staged_existing_on_fresh_sort = true;
  settings.ui_force_staged_existing_repair = true;
  settings.ui_disable_staged_existing_repair = false;
  settings.ui_disable_partial_existing_repair = false;
  settings.ui_skip_pre_solve_constraint_release = true;
  settings.ui_disable_automatic_retry = true;
  settings.ui_allow_incomplete_retry_after_single_pass = false;
  settings.ui_stop_after_first_complete_schedule = true;
  settings.complete_schedule_seed_retry = false;
  settings.complete_schedule_seed_retry_max_runs = 0;
  settings.preserve_existing_tkb = true;
  settings.preserve_fixed_lessons_only = true;
  settings.existing_fill_missing_schedule = true;
  settings.optimize_existing_schedule = false;
  settings.allow_quality_debt = true;
  settings.require_complete_schedule = true;
  settings.ui_unified_repair_ceiling_seconds = Math.max(1, Number(ceilingSeconds || 10) || 10);
  const state = bridge.internals.applyPartialExistingRepairSettings(
    settings,
    data,
    "benchmark_four_missing_residual"
  );
  if(!state?.eligible){
    throw new Error(`Prepared partial repair is not eligible: ${JSON.stringify(state)}`);
  }
  settings.repair_residual_lns_time_limit_seconds = Math.min(
    7,
    Math.max(2, Number(settings.repair_existing_missing_periods || 1) || 1)
  );
  return {
    kind:"repair_partial",
    settings,
    state,
    released:0,
    qualityTargets:planned.qualityTargets
  };
}

function buildWireRequest(bridge, settings, data, runId, workers, seed){
  const finalized = bridge.finalize(settings, data, runId);
  const wireSettings = finalized.settings;
  if(workers) wireSettings.num_workers = Math.max(1, Number(workers) || 1);
  if(seed && wireSettings.random_seed != null) wireSettings.random_seed = Number(seed);
  wireSettings.solve_run_id = runId;
  wireSettings.ui_solve_run_id = runId;
  return {
    request:{data:finalized.data, settings:wireSettings},
    finalizer:{
      partialState:finalized.partialState,
      fixedLessonPreserveCount:finalized.fixedLessonPreserveCount
    }
  };
}

function buildFreshFallback(bridge, scenario, runId, workers, seed){
  if(!["constraint-repair", "repair"].includes(scenario.lane)) return null;
  const freshSettings = bridge.internals.stagedExistingFreshRetrySettings(
    Object.assign({}, scenario.planned.settings),
    scenario.data,
    runId
  );
  const built = buildWireRequest(bridge, freshSettings, scenario.data, `${runId}-fresh`, workers, seed);
  return Object.assign(built, {phase:"fresh", settings:freshSettings});
}

function buildBenchmarkScenario(args){
  const lane = String(args.lane || "fresh").toLowerCase();
  const base = readJsonFileUtf8(args.base);
  const data = cloneJson(base.data || base || {});
  let incumbentState = {fixedCount:fixedCells(data.tkb).length, removed:[]};
  if(["refine", "repair", "constraint-repair", "fresh-after-delete"].includes(lane)){
    if(!args.incumbent) throw new Error(`${lane} requires --incumbent`);
    const response = readJsonFileUtf8(args.incumbent);
    const payload = response.payload || response;
    const missingClass = String(args["missing-class"] || "").trim();
    const missingCells = parseMissingCells(args["missing-cells"], missingClass);
    incumbentState = installIncumbent(
      data,
      payload,
      lane === "repair" ? Number(args.missing || missingCells.length || 4) : 0,
      {missingClass, missingCells}
    );
  }
  const teacherConstraintAdded = setTeacherMaxDays(data, args.teacher, args["max-days"]);
  if(lane === "constraint-repair" && !teacherConstraintAdded){
    throw new Error("constraint-repair requires --teacher and --max-days");
  }
  if(lane === "fresh-after-delete") incumbentState.cleared = clearFlexibleTimetable(data);

  const bridge = loadBridge(data, Number(args.hardware || 6));
  const expected = bridge.internals.expectedLessonCount(data);
  const scheduleSnapshot = cloneJson(bridge.internals.snapshotScheduleData(data));
  const snapshotBefore = snapshotFields(scheduleSnapshot);
  const scheduleHashBefore = canonicalHash(snapshotBefore);
  const fingerprintBefore = bridge.internals.scheduleFingerprintFromData(data);
  const uiViolations = cloneJson(bridge.internals.currentConstraintViolations(3000));
  const benchmarkViolations = benchmarkConstraintViolations(data);
  const seenViolations = new Set();
  const violations = [...uiViolations, ...benchmarkViolations].filter(item => {
    const key = [item?.kind || item?.type, item?.teacher, item?.maxDays, item?.actualDays].join("|");
    if(seenViolations.has(key)) return false;
    seenViolations.add(key);
    return true;
  });
  const preparedFreshPlan = bridge.internals.buildFreshQualityAutoSortSettings(data, expected, "balanced");
  let planned;
  if(lane === "constraint-repair"){
    if(violations.length <= 0 && args["allow-noop-constraint"] !== true){
      throw new Error("constraint-repair did not create a real incumbent violation");
    }
    planned = bridge.internals.buildConstraintRepairAutoSortPlan(
      data,
      expected,
      0,
      violations.length,
      preparedFreshPlan
    );
  }else{
    planned = bridge.hooks.buildAutomaticAutoSortPlan(data, expected, violations.length, preparedFreshPlan);
    if(lane === "repair"){
      planned = buildPartialRepairPlan(
        bridge,
        data,
        planned,
        Number(args.seconds || 10)
      );
    }
  }

  const fingerprintAfterPlanning = bridge.internals.scheduleFingerprintFromData(data);
  const scheduleHashAfterPlanning = canonicalHash(snapshotFields(
    bridge.internals.snapshotScheduleData(data)
  ));
  if(fingerprintBefore !== fingerprintAfterPlanning || scheduleHashBefore !== scheduleHashAfterPlanning){
    throw new Error("Benchmark planning mutated the visible timetable before the backend request");
  }

  let requestSettings = planned.settings;
  let stagedState = planned.state;
  if(["constraint-repair", "repair"].includes(lane)){
    stagedState = stagedState || bridge.internals.partialExistingRepairState(data, requestSettings);
    if(!stagedState?.eligible){
      throw new Error(`Staged ${lane} request is not eligible: ${JSON.stringify(stagedState)}`);
    }
    requestSettings = bridge.internals.stagedExistingRepairSettings(
      requestSettings,
      stagedState,
      "fill",
      `benchmark-${lane}`
    );
  }
  const runId = String(args["run-id"] || `benchmark-unified-${lane}`);
  const primary = buildWireRequest(
    bridge,
    requestSettings,
    data,
    `${runId}-staged`,
    args.workers,
    args.seed
  );
  const scenario = {
    lane,
    data,
    bridge,
    expected,
    planned,
    stagedState,
    incumbentState,
    teacherConstraintAdded,
    teacherConstraint:teacherConstraintAdded
      ? {teacher:String(args.teacher), maxDays:Number(args["max-days"])}
      : null,
    violations,
    released:0,
    scheduleSnapshot,
    snapshotBefore,
    scheduleHashBefore,
    scheduleHashAfterPlanning,
    fingerprintBefore,
    fingerprintAfterPlanning,
    primary:Object.assign(primary, {phase:"staged"}),
    runId
  };
  scenario.fresh = buildFreshFallback(bridge, scenario, runId, args.workers, args.seed);
  return scenario;
}

function simulateFailedTransactionRestore(scenario){
  const before = snapshotFields(scenario.scheduleSnapshot);
  const beforeHash = canonicalHash(before);
  const cleared = clearFlexibleTimetable(scenario.data);
  scenario.bridge.internals.restoreScheduleData(scenario.data, scenario.scheduleSnapshot);
  const after = snapshotFields(scenario.data);
  const afterHash = canonicalHash(after);
  const constraint = scenario.teacherConstraint;
  const retainedMaxDays = constraint
    ? Number(
        scenario.data?.tkbConstraints?.teacher?.[constraint.teacher]
          ?.maxDaysSessions?.maxDays
      )
    : null;
  return {
    cleared,
    beforeHash,
    afterHash,
    exact:beforeHash === afterHash && JSON.stringify(before) === JSON.stringify(after),
    constraintRetained:constraint ? retainedMaxDays === constraint.maxDays : true,
    retainedMaxDays
  };
}

function referenceSolverRequest(request){
  const next = cloneJson(request);
  next.settings = Object.assign({}, next.settings || {}, {
    solver_mode:"auto",
    native_force_rust_solver:false,
    disable_reference_solver:false,
    disable_hybrid_reference_solver:false
  });
  return next;
}

function runAndValidate(request, args, label){
  const runnerOptions = {
    python:args.python,
    timeoutMs:Number(args.timeout || 0) > 0 ? Number(args.timeout) * 1000 : undefined
  };
  // solve_stdio.py is the Python reference executor. A production staged wire
  // can request the Rust-native lane; adapt only the executor selector while
  // keeping data, requirements, deadlines, and the request fixture unchanged.
  const solverRequest = args["reference-run"] === true
    ? referenceSolverRequest(request)
    : request;
  const solved = runSolverRequest(solverRequest, runnerOptions);
  const validation = validateCandidate(request, solved.payload, runnerOptions);
  return {
    label,
    runnerMode:solverRequest === request ? "wire" : "reference-adapted",
    status:solved.status,
    elapsedMs:solved.elapsedMs,
    payload:solved.payload,
    completion:requestCompletion(solved.payload),
    canonicalValidation:validation.payload,
    canonicalStatus:validation.status,
    stderrText:solved.stderrText
  };
}

function main(){
  const args = parseArgs(process.argv);
  if(!args.base || !args.output){
    throw new Error(
      "Usage: --base request.json --output request.json "
      + "[--lane fresh|refine|repair|constraint-repair|fresh-after-delete] "
      + "[--incumbent response.json] [--run|--reference-run] [--python python.exe]"
    );
  }
  const scenario = buildBenchmarkScenario(args);
  const phase = String(args.phase || "staged").toLowerCase();
  const selected = ["fresh", "fallback"].includes(phase) ? scenario.fresh : scenario.primary;
  if(!selected) throw new Error(`Lane ${scenario.lane} does not have a fresh fallback request`);
  const requestPath = writeJsonFileUtf8(args.output, selected.request);
  const fallbackPath = args["fallback-output"] && scenario.fresh
    ? writeJsonFileUtf8(args["fallback-output"], scenario.fresh.request)
    : null;

  const attempts = [];
  const resultArtifacts = [];
  let fallbackCount = 0;
  if(args.candidate){
    const loaded = readJsonFileUtf8(args.candidate);
    const candidate = loaded.payload || loaded;
    const validated = validateCandidate(selected.request, candidate, {
      python:args.python,
      timeoutMs:Number(args.timeout || 0) > 0 ? Number(args.timeout) * 1000 : undefined
    });
    attempts.push({
      label:phase,
      status:null,
      elapsedMs:0,
      payload:candidate,
      completion:requestCompletion(candidate),
      canonicalValidation:validated.payload,
      canonicalStatus:validated.status,
      stderrText:""
    });
  }else if(args.run === true || args["reference-run"] === true){
    const first = runAndValidate(selected.request, args, phase);
    attempts.push(first);
    const firstAccepted = first.completion.complete && first.canonicalValidation?.ok === true;
    if(
      ["constraint-repair", "repair"].includes(scenario.lane)
      && phase === "staged"
      && !firstAccepted
      && scenario.fresh
    ){
      fallbackCount += 1;
      attempts.push(runAndValidate(scenario.fresh.request, args, "fresh"));
    }
  }
  if(fallbackCount > 1 || attempts.length > 2){
    throw new Error("Transactional benchmark attempted more than one fresh fallback");
  }

  for(const [index, attempt] of attempts.entries()){
    resultArtifacts.push({
      label:attempt.label,
      runnerMode:attempt.runnerMode,
      status:attempt.status,
      elapsedMs:attempt.elapsedMs,
      completion:attempt.completion,
      canonicalStatus:attempt.canonicalStatus,
      canonicalValidation:attempt.canonicalValidation
    });
    if(args.result){
      const resultBase = path.resolve(args.result);
      const resultPath = attempts.length <= 1
        ? resultBase
        : resultBase.replace(/(\.json)?$/i, `-${index + 1}-${attempt.label}.json`);
      writeJsonFileUtf8(resultPath, {status:attempt.status, payload:attempt.payload});
    }
    if(args.stderr && attempt.stderrText){
      const stderrBase = path.resolve(args.stderr);
      const stderrPath = attempts.length <= 1
        ? stderrBase
        : stderrBase.replace(/(\.txt)?$/i, `-${index + 1}-${attempt.label}.txt`);
      fs.mkdirSync(path.dirname(stderrPath), {recursive:true});
      fs.writeFileSync(stderrPath, Buffer.from(attempt.stderrText, "utf8"));
    }
  }

  const rollback = args["simulate-failure"] === true
    ? simulateFailedTransactionRestore(scenario)
    : null;
  if(rollback && (!rollback.exact || !rollback.constraintRetained)){
    throw new Error(`Transactional rollback was not exact: ${JSON.stringify(rollback)}`);
  }
  const primaryData = scenario.primary.request.data;
  const primaryScheduled = scenario.bridge.internals.countScheduledLessons(primaryData);
  const primaryFixed = fixedCells(primaryData.tkb).length;
  const freshData = scenario.fresh?.request?.data || null;
  const evidence = {
    lane:scenario.lane,
    planKind:scenario.planned.kind,
    state:scenario.stagedState,
    incumbentState:scenario.incumbentState,
    released:scenario.released,
    preRelease:false,
    violationCount:scenario.violations.length,
    violationKinds:scenario.violations.map(item => String(item?.kind || item?.type || "unknown")),
    teacherConstraint:scenario.teacherConstraint,
    planningIntegrity:{
      fingerprintUnchanged:scenario.fingerprintBefore === scenario.fingerprintAfterPlanning,
      snapshotHashUnchanged:scenario.scheduleHashBefore === scenario.scheduleHashAfterPlanning,
      fingerprintHash:canonicalHash(scenario.fingerprintBefore),
      snapshotHash:scenario.scheduleHashBefore
    },
    request:{
      phase:selected.phase,
      path:requestPath,
      scheduled:primaryScheduled,
      expected:scenario.expected,
      fixed:primaryFixed,
      flexible:Math.max(0, primaryScheduled - primaryFixed),
      settings:settingsSummary(selected.request.settings),
      finalizer:selected.finalizer
    },
    fallback:scenario.fresh ? {
      generated:true,
      path:fallbackPath,
      scheduled:freshData ? scenario.bridge.internals.countScheduledLessons(freshData) : 0,
      fixed:freshData ? fixedCells(freshData.tkb).length : 0,
      strippedSchedule:freshData?.__tkbRequestStrippedSchedule === true,
      fixedScheduleOnly:freshData?.__tkbRequestFixedScheduleOnly === true,
      settings:settingsSummary(scenario.fresh.request.settings)
    } : {generated:false},
    execution:{
      attempts:resultArtifacts,
      attemptCount:attempts.length,
      fallbackCount,
      maximumFreshFallbacks:1
    },
    rollback
  };
  if(args.evidence) writeJsonFileUtf8(args.evidence, evidence);
  process.stdout.write(Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8"));
  return evidence;
}

module.exports = {
  benchmarkConstraintViolations,
  buildBenchmarkScenario,
  buildFreshFallback,
  buildPartialRepairPlan,
  canonicalHash,
  clearFlexibleTimetable,
  fixedCells,
  installIncumbent,
  loadBridge,
  parseArgs,
  parseMissingCells,
  referenceSolverRequest,
  requestCompletion,
  setTeacherMaxDays,
  simulateFailedTransactionRestore,
  snapshotFields,
  subjectResolver
};

if(require.main === module) main();
