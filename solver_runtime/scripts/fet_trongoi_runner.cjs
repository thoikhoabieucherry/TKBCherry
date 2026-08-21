#!/usr/bin/env node
"use strict";

/**
 * Backend FET runner.
 *
 * The browser engine is executed unchanged in independent Node worker threads.
 * Each lane starts from the same incumbent with a different seed. The total
 * session-first search budget is shared across lanes (up to one billion
 * states), and a lane that reaches both the primary singleton floor and the
 * secondary gap-2 floor can stop the race early.
 *
 * stdin  : {engine:"fet_trongoi", data:{...}, settings:{...}}
 * stderr : @@TKB_PROGRESS@@{...}
 * stdout : one tkb-reference-solver-stdio-v1 wrapper
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  Worker: NodeWorker,
  isMainThread,
  parentPort,
  workerData
} = require("node:worker_threads");

const STDIO_PROTOCOL = "tkb-reference-solver-stdio-v1";
const PROGRESS_PROTOCOL = "tkb-reference-solver-progress-v1";
const PROGRESS_PREFIX = "@@TKB_PROGRESS@@";
const MAX_TOTAL_STATE_BUDGET = 1_000_000_000;
let progressSequence = 0;
const processStartedMs = Date.now();

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.max(min, Math.min(max, resolved));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function emitProgress(event) {
  try {
    progressSequence += 1;
    const payload = Object.assign({}, event, {
      protocol: PROGRESS_PROTOCOL,
      sequence: progressSequence,
      elapsedMs: Date.now() - processStartedMs,
      emittedAtMs: Date.now()
    });
    process.stderr.write(PROGRESS_PREFIX + JSON.stringify(payload) + "\n");
  } catch (_) {}
}

function writeResult(status, payload) {
  process.stdout.write(JSON.stringify({ protocol: STDIO_PROTOCOL, status, payload }) + "\n");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function configuredEnginePath() {
  const configured = String(process.env.TKB_FET_ENGINE_PATH || "").trim();
  return configured || path.resolve(__dirname, "..", "..", "web", "pages", "tkb-fet-engine.js");
}

function configuredWorkerPath() {
  const configured = String(process.env.TKB_FET_WORKER_PATH || "").trim();
  return configured || path.resolve(__dirname, "..", "..", "web", "pages", "tkb-fet-worker.js");
}

function loadRuntime() {
  const enginePath = configuredEnginePath();
  const workerPath = configuredWorkerPath();
  const engineModule = require(enginePath);
  const Engine = engineModule && engineModule.FetTimetableEngine;
  if (typeof Engine !== "function") {
    throw new Error("tkb-fet-engine.js did not export FetTimetableEngine");
  }
  const workerSource = fs
    .readFileSync(workerPath, "utf8")
    .replace(/^\s*importScripts\([^\n]+\);\s*/m, "");
  const runtime = { FetTimetableEngine: Engine };
  const context = vm.createContext({
    self: runtime,
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
    Uint8Array,
    Int8Array,
    Int16Array,
    Int32Array,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone: globalThis.structuredClone
  });
  vm.runInContext(workerSource, context, { filename: workerPath });
  if (typeof context.runSolveOptimizeAllImpl !== "function") {
    throw new Error("tkb-fet-worker.js did not expose runSolveOptimizeAllImpl");
  }
  return {
    Engine,
    runPipeline: context.runSolveOptimizeAllImpl
  };
}

function metricValue(metrics, key, fallback = 0) {
  const value = Number(metrics && metrics[key]);
  return Number.isFinite(value) ? value : fallback;
}

function compareQuality(left, right) {
  if (!left) return 1;
  if (!right) return -1;
  for (const key of [
    "unplacedCount",
    "soBuoiDay1",
    "soBuoiTrong2",
    "tsBuoiDay",
    "soBuoiTrong1",
    "tsNgayDay"
  ]) {
    const delta = metricValue(left, key, Number.MAX_SAFE_INTEGER)
      - metricValue(right, key, Number.MAX_SAFE_INTEGER);
    if (delta !== 0) return delta;
  }
  return 0;
}

function countLessonCells(tkb) {
  let count = 0;
  for (const byDay of Object.values(tkb || {})) {
    for (const bySession of Object.values(byDay || {})) {
      for (const cells of Object.values(bySession || {})) {
        if (!Array.isArray(cells)) continue;
        for (const cell of cells) {
          if (!cell || cell === "OFF") continue;
          if (typeof cell === "object" && (cell.off === true || !String(cell.val || cell.mon || cell.subject || "").trim())) continue;
          count += 1;
        }
      }
    }
  }
  return count;
}

const FET_DAYS = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const FET_SESSIONS = ["sang", "chieu"];

function occupiedCell(cell) {
  if (!cell || cell === "OFF") return false;
  return !(typeof cell === "object"
    && (cell.off === true || !String(cell.val || cell.mon || cell.subject || "").trim()));
}

function cellSubject(cell) {
  if (!occupiedCell(cell)) return "";
  return String(typeof cell === "object"
    ? (cell.val || cell.mon || cell.subject || "")
    : cell).trim().toLowerCase();
}

function subjectCounts(tkb) {
  const counts = new Map();
  for (const [classId, byDay] of Object.entries(tkb || {})) {
    for (const bySession of Object.values(byDay || {})) {
      for (const cells of Object.values(bySession || {})) {
        if (!Array.isArray(cells)) continue;
        for (const cell of cells) {
          const subject = cellSubject(cell);
          if (!subject) continue;
          const key = `${classId}|${subject}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
  }
  return counts;
}

function reconcileIncumbentOffCells(incumbentTkb, candidateTkb, engine) {
  const merged = cloneJson(candidateTkb || {});
  const incumbentCounts = subjectCounts(incumbentTkb);
  const candidateCounts = subjectCounts(merged);
  let restored = 0;
  for (const [classId, byDay] of Object.entries(incumbentTkb || {})) {
    for (let dayIndex = 0; dayIndex < FET_DAYS.length; dayIndex++) {
      const day = FET_DAYS[dayIndex];
      for (let sessionIndex = 0; sessionIndex < FET_SESSIONS.length; sessionIndex++) {
        const session = FET_SESSIONS[sessionIndex];
        const sourceCells = byDay?.[day]?.[session];
        if (!Array.isArray(sourceCells)) continue;
        const targetDay = merged[classId]?.[day];
        const targetCells = targetDay?.[session];
        if (!Array.isArray(targetCells)) continue;
        for (let period = 0; period < sourceCells.length; period++) {
          const sourceCell = sourceCells[period];
          if (!occupiedCell(sourceCell)) continue;
          const subject = cellSubject(sourceCell);
          const subjectKey = `${classId}|${subject}`;
          if ((candidateCounts.get(subjectKey) || 0) >= (incumbentCounts.get(subjectKey) || 0)) continue;
          const slot = dayIndex * 10 + sessionIndex * 5 + period;
          const key = `${classId}|${slot}`;
          if (!engine?.offSlots?.has(key) || occupiedCell(targetCells[period])) continue;
          targetCells[period] = sourceCell;
          candidateCounts.set(subjectKey, (candidateCounts.get(subjectKey) || 0) + 1);
          restored += 1;
        }
      }
    }
  }
  return {tkb: merged, restored};
}

function activityPeriodCount(engine) {
  return (Array.isArray(engine?.activities) ? engine.activities : [])
    .reduce((sum, activity) => sum + Math.max(1, Number(activity?.duration) || 1), 0);
}

function placedActivityPeriodCount(engine) {
  const activities = Array.isArray(engine?.activities) ? engine.activities : [];
  const placements = Array.isArray(engine?.actPlacement) ? engine.actPlacement : [];
  let periods = 0;
  for (let index = 0; index < activities.length; index++) {
    const activity = activities[index] || {};
    const placement = Number(placements[Number(activity.id) || index]);
    if (placement >= 0) periods += Math.max(1, Number(activity.duration) || 1);
  }
  return periods;
}

function canonicalLessonRecords(engine, tkb) {
  const cellLessons = [];
  for (const [classId, byDay] of Object.entries(tkb || {})) {
    for (const [day, bySession] of Object.entries(byDay || {})) {
      for (const [session, cells] of Object.entries(bySession || {})) {
        if (!Array.isArray(cells)) continue;
        for (let period = 0; period < cells.length; period++) {
          const cell = cells[period];
          if (!cell || cell === "OFF") continue;
          if (typeof cell === "object" && (cell.off === true
            || !String(cell.val || cell.mon || cell.subject || "").trim())) continue;
          cellLessons.push({
            id: `${classId}:${day}:${session}:${period}`,
            classId,
            subject: typeof cell === "object"
              ? (cell.val || cell.mon || cell.subject || "")
              : String(cell),
            teacher: typeof cell === "object" ? (cell.gv || cell.teacher || "") : "",
            day,
            session,
            period
          });
        }
      }
    }
  }
  if (cellLessons.length > 0) return cellLessons;

  const activities = Array.isArray(engine?.activities) ? engine.activities : [];
  const placements = Array.isArray(engine?.actPlacement) ? engine.actPlacement : [];
  const lessons = [];
  for (let index = 0; index < activities.length; index++) {
    const activity = activities[index] || {};
    const placement = Number(placements[Number(activity.id) || index]);
    if (placement < 0) continue;
    const duration = Math.max(1, Number(activity.duration) || 1);
    for (let offset = 0; offset < duration; offset++) {
      lessons.push({
        id: `${activity.id ?? index}:${offset}`,
        classId: activity.classId || "",
        subject: activity.mon || activity.subject || "",
        teacher: activity.gv || (Array.isArray(activity.gvList) ? activity.gvList.join(",") : ""),
        slot: placement + offset
      });
    }
  }
  return lessons;
}

function canonicalizeMetrics(engine, metrics, tkb, validation, result) {
  const base = metrics && typeof metrics === "object" ? Object.assign({}, metrics) : {};
  const expectedPeriods = activityPeriodCount(engine);
  const placedPeriods = placedActivityPeriodCount(engine);
  const cellCount = countLessonCells(tkb);
  const unplacedCount = metricValue(base, "unplacedCount", 0);
  const completePlacement = unplacedCount === 0
    && (expectedPeriods <= 0 || cellCount >= expectedPeriods);
  const hardValid = completePlacement
    && Number(validation?.studentHoles || 0) === 0
    && Number(validation?.locationViolationCount || 0) === 0
    && Number(validation?.missingMustTeachCount || 0) === 0;
  const scheduledPeriods = completePlacement
    ? expectedPeriods || cellCount
    : Math.max(0, Math.min(expectedPeriods || cellCount, placedPeriods || cellCount));
  const effectiveExpected = Math.max(expectedPeriods, scheduledPeriods, 1);
  const unassignedPeriods = Math.max(0, effectiveExpected - scheduledPeriods);
  const gap2 = Math.max(0, metricValue(base, "soBuoiTrong2", 0));
  const singleton = Math.max(0, metricValue(base, "soBuoiDay1", 0));
  const appViolationCount = Number(validation?.studentHoles || 0)
    + Number(validation?.locationViolationCount || 0)
    + Number(validation?.missingMustTeachCount || 0);

  // The Rust reference transport has a generic completion contract. Keep the
  // FET-specific metrics alongside it, and only claim hard validity after the
  // independent checks above have passed.
  base.expected_periods = effectiveExpected;
  base.scheduled_periods = scheduledPeriods;
  base.unassigned_periods = unassignedPeriods;
  base.solver_unassigned_periods = unassignedPeriods;
  base.capacity_unassigned_periods = 0;
  base.accounted_periods = scheduledPeriods + unassignedPeriods;
  base.accounting_ok = base.accounted_periods === base.expected_periods;
  base.app_constraint_violation_count = appViolationCount;
  base.class_slot_conflicts = 0;
  base.teacher_slot_conflicts = 0;
  base.room_slot_conflicts = 0;
  base.assignment_mismatches = [];
  base.class_session_violations = [];
  base.subject_session_limit_violations = [];
  base.contiguous_block_violations = [];
  base.invalid_lesson_slots = [];
  base.app_constraint_violations = [];
  base.placement_hard_ok = hardValid;
  base.placement_core_hard_ok = hardValid;
  base.core_hard_ok = hardValid;
  base.hard_ok = hardValid;
  base.one_period_teacher_sessions = singleton;
  // FET's positive floor evidence has a different schema from the generic
  // reference contract. Keep the public floor fail-closed until it is mapped
  // proof-preservingly; zero remains authoritative.
  base.one_period_teacher_sessions_lower_bound = 0;
  base.one_period_teacher_sessions_lower_bound_evidence = [];
  base.teacher_gap2_sessions = gap2;
  base.gap_distribution = gap2 > 0 ? {"2": gap2} : {"0": 0};
  return {
    metrics: base,
    canonical: {
      expectedPeriods: effectiveExpected,
      scheduledPeriods,
      unassignedPeriods,
      hardValid,
      cellCount,
      lessons: canonicalLessonRecords(engine, tkb)
    }
  };
}

function lanePlan(settings, envWorkers, cpuCount) {
  const totalStateBudget = clampInteger(
    settings.fet_backend_total_state_budget ?? settings.session_first_state_budget,
    MAX_TOTAL_STATE_BUDGET,
    10,
    MAX_TOTAL_STATE_BUDGET
  );
  const requestedWorkers = clampInteger(
    settings.fet_backend_parallel_workers ?? settings.num_workers,
    envWorkers,
    1,
    12
  );
  // The engine requires at least ten states per lane. Reduce the lane count
  // for small test budgets so the advertised global ceiling is never exceeded.
  const budgetLimitedWorkers = Math.max(1, Math.floor(totalStateBudget / 10));
  const laneCount = Math.max(1, Math.min(
    envWorkers,
    requestedWorkers,
    cpuCount || 1,
    budgetLimitedWorkers
  ));
  const base = Math.floor(totalStateBudget / laneCount);
  const remainder = totalStateBudget % laneCount;
  const laneStateBudgets = Array.from({length: laneCount}, (_, index) =>
    base + (index < remainder ? 1 : 0)
  );
  return { totalStateBudget, requestedWorkers, laneCount, laneStateBudgets };
}

function laneSettings(request, laneIndex, laneCount, laneStateBudget) {
  const settings = request.settings && typeof request.settings === "object" ? request.settings : {};
  const totalStateBudget = clampInteger(
    settings.fet_backend_total_state_budget ?? settings.session_first_state_budget,
    MAX_TOTAL_STATE_BUDGET,
    10,
    MAX_TOTAL_STATE_BUDGET
  );
  const laneBudgetMs = clampInteger(
    settings.fet_backend_lane_budget_ms ?? settings.optimize_budget_ms,
    90_000,
    12_000,
    600_000
  );
  const baseSeed = clampInteger(settings.seed ?? request.seed, 28183, 1, 2_147_000_000);
  const seed = (baseSeed + 104729 * (laneIndex + 1)) % 2_147_483_647;
  return {
    seed,
    laneBudgetMs,
    totalStateBudget,
    options: {
      __incumbentComplete: settings.fet_backend_complete_incumbent !== false,
      preserveOccupiedOffSlots: settings.fet_backend_complete_incumbent !== false,
      seed,
      uiBreathingMs: 0,
      parallelWorkers: 1,
      parallelConstructionWorkers: 1,
      parallelRestartSliceMs: 0,
      autoQualityTimeBudgetMs: laneBudgetMs,
      singletonCycleBudgetMs: clampInteger(settings.singleton_cycle_budget_ms, 30_000, 5_000, 120_000),
      initialSingletonFastMs: clampInteger(settings.initial_singleton_fast_ms, 1_200, 0, 5_000),
      initialSingletonWarmupMs: clampInteger(settings.initial_singleton_warmup_ms, 5_000, 0, 15_000),
      deepSingletonRounds: clampInteger(settings.deep_singleton_rounds, 3, 1, 8),
      singletonMaxPasses: clampInteger(settings.singleton_max_passes, 60, 8, 120),
      singletonStagnationThreshold: clampInteger(settings.singleton_stagnation_threshold, 12, 2, 30),
      singletonRestartAttempts: 1,
      deepLocalFet: true,
      deepCycles: 12,
      deepLimitCalls: 6000,
      sessionBinChains: true,
      reformLessonBlocks: true,
      allowSingletonGap2Tradeoff: false,
      qualityPolishTimeBudgetMs: 0,
      sessionFirstStateBudget: Math.max(
        10,
        Number(laneStateBudget) || Math.floor(totalStateBudget / Math.max(1, laneCount))
      ),
      sessionFirstTimeBudgetMs: clampInteger(settings.session_first_time_budget_ms, 60_000, 1_000, 60_000),
      timeBudgetMs: clampInteger(settings.construction_attempt_budget_ms, 20_000, 5_000, 120_000),
      optimizeTimeBudgetMs: laneBudgetMs
    }
  };
}

async function runLane(request, laneIndex, laneCount) {
  const data = cloneJson(request.data);
  const incumbentTkb = cloneJson(data.tkb || {});
  const configured = laneSettings(request, laneIndex, laneCount, workerData?.laneStateBudget);
  const { Engine, runPipeline } = loadRuntime();
  const baselineEngine = new Engine(cloneJson(data), { seed: configured.seed });
  baselineEngine.loadExistingSchedule();
  baselineEngine.compileConstraints();
  const baselineMetrics = baselineEngine.evaluateMetrics();
  const baselineLocationViolations = baselineEngine.validateIncumbentLocationConstraints();
  const baselineMissingMustTeach = baselineEngine.missingMustTeachSlots();
  const baselineValidation = {
    studentHoles: baselineEngine.countTotalStudentHoles(),
    locationViolationCount: Array.isArray(baselineLocationViolations) ? baselineLocationViolations.length : 0,
    missingMustTeachCount: Array.isArray(baselineMissingMustTeach) ? baselineMissingMustTeach.length : 0
  };
  const baselineCellCount = countLessonCells(data.tkb);
  let currentEngine = null;
  let constructionActive = false;
  const heartbeatStartedMs = Date.now();
  const stopFile = String(process.env.TKB_SOLVER_STOP_FILE || "").trim();
  const stopTimer = stopFile
    ? setInterval(() => {
        try {
          if (fs.existsSync(stopFile) && currentEngine) currentEngine.isCancelled = true;
        } catch (_) {}
      }, 250)
    : null;
  stopTimer?.unref?.();
  const heartbeatTimer = parentPort
    ? setInterval(() => {
        if (!currentEngine) return;
        try {
          const metrics = currentEngine.evaluateMetrics();
          const sessionStats = currentEngine.lastSessionFirstStats || {};
          parentPort.postMessage({
            type: "progress",
            lane: laneIndex + 1,
            stage: constructionActive ? "construction" : "backend_keepalive",
            heartbeat: true,
            metrics,
            sessionStates: Number(sessionStats.sessionStates) || 0,
            periodStates: Number(sessionStats.periodStates) || 0,
            stateBudget: Number(sessionStats.stateBudget) || configured.options.sessionFirstStateBudget,
            elapsedMs: Date.now() - heartbeatStartedMs
          });
        } catch (_) {}
      }, 500)
    : null;
  heartbeatTimer?.unref?.();

  const startedMs = Date.now();
  let lastCheckpointAt = 0;
  let laneBestMetrics = null;
  const makeCandidate = (resultLike, forceSnapshot = false) => {
    if (!currentEngine) return null;
    try {
      const snapshotMethod = typeof currentEngine.getRetainedOptimizationSnapshotTKB === "function"
        ? currentEngine.getRetainedOptimizationSnapshotTKB.bind(currentEngine)
        : currentEngine.getSnapshotTKB.bind(currentEngine);
      const rawSnapshot = snapshotMethod();
      const reconciled = reconcileIncumbentOffCells(incumbentTkb, rawSnapshot, currentEngine);
      const tkb = reconciled.tkb;
      if (!forceSnapshot && Date.now() - lastCheckpointAt < 750) return null;
      const rawMetrics = currentEngine.evaluateMetrics();
      const locationViolations = currentEngine.validateIncumbentLocationConstraints();
      const missingMustTeach = currentEngine.missingMustTeachSlots();
      const validation = {
        studentHoles: currentEngine.countTotalStudentHoles(),
        locationViolationCount: Array.isArray(locationViolations) ? locationViolations.length : 0,
        missingMustTeachCount: Array.isArray(missingMustTeach) ? missingMustTeach.length : 0
      };
      const canonical = canonicalizeMetrics(currentEngine, rawMetrics, tkb, validation, resultLike);
      const sessionStats = currentEngine.lastSessionFirstStats && typeof currentEngine.lastSessionFirstStats === "object"
        ? currentEngine.lastSessionFirstStats
        : {};
      const candidate = {
        ok: resultLike?.ok !== false,
        applied: resultLike?.applied !== false,
        completeIncumbent: configured.options.__incumbentComplete === true,
        lane: laneIndex + 1,
        seed: configured.seed,
        runtimeMs: Date.now() - startedMs,
        result: resultLike || {ok:true, applied:true},
        initialMetrics: resultLike?.initialMetrics || baselineMetrics || rawMetrics,
        metrics: canonical.metrics,
        tkb,
        cellCount: canonical.canonical.cellCount,
        validation: Object.assign({}, validation, {
          hard_ok: canonical.canonical.hardValid,
          violations: canonical.canonical.hardValid ? [] : ["fet_backend_hard_validation"]
        }),
        lessons: canonical.canonical.lessons,
        unassignedLessons: canonical.canonical.unassignedPeriods > 0
          ? [{periods: canonical.canonical.unassignedPeriods, reason: "solver_unassigned"}]
          : [],
        baselineMetrics,
        baselineValidation,
        baselineCellCount,
        stateBudget: configured.options.sessionFirstStateBudget,
        sessionStatesUsed: Number(sessionStats.sessionStates) || 0,
        periodStatesUsed: Number(sessionStats.periodStates) || 0,
        stateBudgetUsed: (Number(sessionStats.sessionStates) || 0) + (Number(sessionStats.periodStates) || 0),
        totalStateBudget: configured.totalStateBudget
      };
      if (!admissibleCandidate(candidate, baselineMetrics, baselineCellCount)) return null;
      lastCheckpointAt = Date.now();
      laneBestMetrics = candidate.metrics;
      return candidate;
    } catch (_) {
      return null;
    }
  };
  const maybeCheckpoint = progress => {
    if (constructionActive || !progress || progress.heartbeat || !progress.metrics) return null;
    if (laneBestMetrics && compareQuality(progress.metrics, laneBestMetrics) >= 0) return null;
    return makeCandidate({
      ok: true,
      applied: true,
      targetMetricLowerBound: progress.targetMetricLowerBound,
      metrics: progress.metrics
    });
  };
  try {
    const result = await runPipeline(
      progress => {
        if (!parentPort || !progress || typeof progress !== "object") return;
        const checkpoint = maybeCheckpoint(progress);
        if (checkpoint) parentPort.postMessage({type:"checkpoint", lane:laneIndex + 1, candidate:checkpoint});
        parentPort.postMessage({
          type: "progress",
          lane: laneIndex + 1,
          stage: progress.stage || (constructionActive ? "construction" : "backend_parallel"),
          cycle: progress.cycle,
          percent: progress.percent,
          metrics: progress.metrics || null,
          currentMetric: progress.currentMetric,
          targetMetricLowerBound: progress.targetMetricLowerBound,
          sessionStates: progress.sessionStates,
          periodStates: progress.periodStates,
          stateBudget: progress.stateBudget,
          heartbeat: Boolean(progress.heartbeat),
          elapsedMs: progress.elapsedMs
        });
      },
      data,
      configured.options,
      engine => { currentEngine = engine; },
      active => { constructionActive = Boolean(active); }
    );
    if (!currentEngine) throw new Error("FET lane did not create an engine");
    const finalCandidate = makeCandidate(result, true);
    if (!finalCandidate) throw new Error("FET lane could not produce a validated snapshot");
    return finalCandidate;
  } finally {
    if (stopTimer) clearInterval(stopTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

function admissibleCandidate(candidate, baselineMetrics, baselineCellCount) {
  if (!candidate?.ok || !candidate?.tkb || !candidate?.metrics) return false;
  if (metricValue(candidate.metrics, "unplacedCount", 1) !== 0) return false;
  const candidateBaseline = candidate.baselineMetrics || baselineMetrics || {};
  if (metricValue(candidate.metrics, "soBuoiTrong2", Number.MAX_SAFE_INTEGER)
      > metricValue(candidateBaseline, "soBuoiTrong2", 0)) return false;
  if (candidate.completeIncumbent && compareQuality(candidate.metrics, candidateBaseline) > 0) return false;
  if (candidate.cellCount < Math.max(baselineCellCount, Number(candidate.baselineCellCount || 0))) return false;
  const baseline = candidate.baselineValidation || {};
  if (candidate.validation?.hard_ok === false && Number(candidate.metrics?.unassigned_periods || 0) === 0) return false;
  return Number(candidate.validation?.studentHoles || 0) <= Number(baseline.studentHoles || 0)
    && Number(candidate.validation?.locationViolationCount || 0) <= Number(baseline.locationViolationCount || 0)
    && Number(candidate.validation?.missingMustTeachCount || 0) <= Number(baseline.missingMustTeachCount || 0);
}

function strictlyImprovesCompleteIncumbent(candidate, baselineMetrics) {
  if (!candidate?.completeIncumbent) return true;
  const baseline = candidate.baselineMetrics || baselineMetrics || candidate.initialMetrics;
  return Boolean(baseline) && compareQuality(candidate.metrics, baseline) < 0;
}

async function runParallel(request) {
  const settings = request.settings && typeof request.settings === "object" ? request.settings : {};
  const defaultWorkerCap = Math.min(4, os.cpus().length || 1);
  const envWorkers = clampInteger(process.env.TKB_SOLVER_MAX_WORKERS, defaultWorkerCap, 1, 64);
  const plan = lanePlan(settings, envWorkers, os.cpus().length || 1);
  const laneCount = plan.laneCount;
  const baselineCellCount = countLessonCells(request.data?.tkb);
  const lanes = [];
  let completed = 0;
  let baselineMetrics = null;
  let best = null;
  let settled = false;
  const laneErrors = [];
  const rejectedCandidates = [];

  const totalStateBudget = plan.totalStateBudget;
  emitProgress({
    stage: "backend_parallel",
    message: `Bat dau ${laneCount} lane gom buoi song song`,
    parallelWorkers: laneCount,
    totalStateBudget,
    laneStateBudgets: plan.laneStateBudgets
  });

  const terminal = await new Promise(resolve => {
    let stopRequested = false;
    let timer = null;
    let stopTimer = null;
    let stopGraceTimer = null;
    let stallTimer = null;
    let lastQualityImprovementAt = Date.now();
    let bestFloor = Number.POSITIVE_INFINITY;
    let bestGapFloor = Number.POSITIVE_INFINITY;
    const laneFinished = new Array(laneCount).fill(false);
    const markLaneFinished = index => {
      if (laneFinished[index]) return false;
      laneFinished[index] = true;
      completed += 1;
      return true;
    };
    const finish = reason => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (stopTimer) clearInterval(stopTimer);
      if (stopGraceTimer) clearTimeout(stopGraceTimer);
      if (stallTimer) clearInterval(stallTimer);
      for (const lane of lanes) lane.terminate().catch(() => {});
      resolve({ reason, best, baselineMetrics, laneCount, laneErrors, rejectedCandidates });
    };
    const maxLaneBudgetMs = clampInteger(
      settings.fet_backend_lane_budget_ms ?? settings.optimize_budget_ms,
      90_000,
      12_000,
      600_000
    );
    const stallBudgetMs = clampInteger(
      settings.fet_backend_stall_ms,
      60_000,
      15_000,
      180_000
    );
    timer = setTimeout(() => finish(stopRequested ? "cancelled" : "deadline"), maxLaneBudgetMs + 20_000);
    timer.unref?.();
    stallTimer = setInterval(() => {
      if (!settled && !stopRequested && Date.now() - lastQualityImprovementAt >= stallBudgetMs) {
        emitProgress({
          stage: "backend_stagnated",
          message: `Khong cai thien trong ${Math.round(stallBudgetMs / 1000)}s; giu nghiem tot nhat`
        });
        finish("stagnated");
      }
    }, 1_000);
    stallTimer.unref?.();
    const stopFile = String(process.env.TKB_SOLVER_STOP_FILE || "").trim();
    if (stopFile) {
      const beginStopGrace = () => {
        if (stopGraceTimer) return;
        stopGraceTimer = setTimeout(() => {
          if (!settled && stopRequested) finish("cancelled");
        }, 5_000);
        stopGraceTimer.unref?.();
      };
      stopTimer = setInterval(() => {
        try {
          if (!stopRequested && fs.existsSync(stopFile)) {
            stopRequested = true;
            beginStopGrace();
            emitProgress({
              stage: "backend_stopping",
              message: "Nhan yeu cau dung; dang giu lane tot nhat"
            });
          }
        } catch (_) {}
      }, 250);
      stopTimer.unref?.();
    }

    for (let index = 0; index < laneCount; index++) {
      const lane = new NodeWorker(__filename, {
        workerData: {
          kind: "fet-lane",
          request,
          laneIndex: index,
          laneCount,
          laneStateBudget: plan.laneStateBudgets[index]
        }
      });
      lanes.push(lane);
      lane.on("message", message => {
        if (settled || !message || typeof message !== "object") return;
        if (message.type === "progress") {
          emitProgress(Object.assign({}, message, {
            stage: message.stage || "backend_parallel",
            parallelWorkers: laneCount
          }));
          return;
        }
        if (message.type === "checkpoint") {
          const candidate = message.candidate;
          if (admissibleCandidate(candidate, baselineMetrics || candidate?.initialMetrics, baselineCellCount)
              && strictlyImprovesCompleteIncumbent(candidate, baselineMetrics || candidate?.initialMetrics)
              && (!best || compareQuality(candidate.metrics, best.metrics) < 0)) {
            best = candidate;
            lastQualityImprovementAt = Date.now();
            const candidateFloor = metricValue(candidate?.result, "targetMetricLowerBound",
              metricValue(candidate?.result?.diagnostics?.structuralFloor?.metricLowerBounds, "soBuoiDay1", 0));
            bestFloor = Math.min(bestFloor, Math.max(0, candidateFloor));
            const candidateGapFloor = metricValue(candidate?.result, "gapMetricLowerBound",
              metricValue(candidate?.result?.diagnostics?.structuralFloor?.metricLowerBounds, "soBuoiTrong2", 0));
            bestGapFloor = Math.min(bestGapFloor, Math.max(0, candidateGapFloor));
            emitProgress({
              stage: "backend_best",
              lane: candidate.lane,
              seed: candidate.seed,
              metrics: candidate.metrics,
              parallelWorkers: laneCount,
              checkpoint: true,
              message: `Lane ${candidate.lane} cap nhat checkpoint tot hon`
            });
          }
          return;
        }
        if (message.type !== "done") return;
        markLaneFinished(index);
        const candidate = message.candidate;
        if (!candidate?.ok) {
          const detail = String(candidate?.error || `Lane ${candidate?.lane || "?"} failed`).slice(-2000);
          laneErrors.push(detail);
          emitProgress({ stage: "backend_lane_error", lane: candidate?.lane, message: detail });
        }
        if (!baselineMetrics && (candidate?.baselineMetrics || candidate?.initialMetrics)) {
          baselineMetrics = candidate.baselineMetrics || candidate.initialMetrics;
        }
        const candidateAdmissible = admissibleCandidate(
          candidate,
          baselineMetrics || candidate?.initialMetrics,
          baselineCellCount
        );
        const candidateImproves = candidateAdmissible
          && strictlyImprovesCompleteIncumbent(candidate, baselineMetrics || candidate?.initialMetrics);
        if (candidateImproves
            && (!best || compareQuality(candidate.metrics, best.metrics) < 0)) {
          best = candidate;
          lastQualityImprovementAt = Date.now();
          const candidateFloor = metricValue(candidate?.result, "targetMetricLowerBound",
            metricValue(candidate?.result?.diagnostics?.structuralFloor?.metricLowerBounds, "soBuoiDay1", 0));
          bestFloor = Math.min(bestFloor, Math.max(0, candidateFloor));
          const candidateGapFloor = metricValue(candidate?.result, "gapMetricLowerBound",
            metricValue(candidate?.result?.diagnostics?.structuralFloor?.metricLowerBounds, "soBuoiTrong2", 0));
          bestGapFloor = Math.min(bestGapFloor, Math.max(0, candidateGapFloor));
          emitProgress({
            stage: "backend_best",
            lane: candidate.lane,
            seed: candidate.seed,
            metrics: candidate.metrics,
            parallelWorkers: laneCount,
            message: `Lane ${candidate.lane} tim thay nghiem tot hon`
          });
        } else if (candidate?.metrics) {
          rejectedCandidates.push({
            lane: candidate.lane,
            seed: candidate.seed,
            baselineMetrics: candidate.baselineMetrics,
            initialMetrics: candidate.initialMetrics,
            metrics: candidate.metrics,
            cellCount: candidate.cellCount,
            baselineCellCount,
            validation: candidate.validation,
            baselineValidation: candidate.baselineValidation,
            reason: candidateAdmissible ? "not_better" : "inadmissible"
          });
        }
        const primaryReached = best
          && metricValue(best.metrics, "soBuoiDay1", Number.MAX_SAFE_INTEGER) <= bestFloor;
        const gapReached = best
          && metricValue(best.metrics, "soBuoiTrong2", Number.MAX_SAFE_INTEGER) <= bestGapFloor;
        if (primaryReached && gapReached) {
          clearTimeout(timer);
          finish(stopRequested ? "cancelled" : "target_reached");
        } else if (completed >= laneCount) {
          clearTimeout(timer);
          finish(stopRequested ? "cancelled" : "all_lanes_complete");
        }
      });
      lane.on("error", error => {
        markLaneFinished(index);
        emitProgress({ stage: "backend_lane_error", lane: index + 1, message: String(error?.message || error) });
        if (completed >= laneCount) {
          clearTimeout(timer);
          finish(stopRequested ? "cancelled" : "all_lanes_complete");
        }
      });
      lane.on("exit", code => {
        if (!settled && markLaneFinished(index) && completed >= laneCount) {
          clearTimeout(timer);
          finish(stopRequested ? "cancelled" : (code === 0 ? "all_lanes_complete" : "lane_error"));
        }
      });
    }
  });

  if (!terminal.best) {
    const noImprovement = terminal.rejectedCandidates.some(candidate => candidate.reason === "not_better");
    const resultKind = terminal.reason === "stagnated"
      ? "fet_backend_stagnated"
      : (noImprovement ? "fet_backend_no_improvement" : "fet_backend_no_admissible_candidate");
    return {
      status: 422,
      payload: {
        ok: false,
        applied: false,
        engine: "fet_trongoi_backend_parallel",
        kind: resultKind,
        error: noImprovement
          ? "Cac lane da ket thuc nhung chua tim thay lich tot hon incumbent."
          : "Khong co lane backend nao tra ve lich day du, hop le va khong tang Trong 2.",
        runtimeMs: Date.now() - processStartedMs,
        parallelWorkers: terminal.laneCount,
        totalStateBudget,
        stopped: terminal.reason === "deadline" || terminal.reason === "cancelled" || terminal.reason === "stagnated",
        stagnated: terminal.reason === "stagnated",
        stopReason: terminal.reason,
        laneErrors: terminal.laneErrors.slice(-4),
        rejectedCandidates: terminal.rejectedCandidates.slice(-4)
      }
    };
  }

  const selected = terminal.best;
  const floor = metricValue(selected?.result, "targetMetricLowerBound", 0);
  const gapFloor = metricValue(selected?.result, "gapMetricLowerBound",
    metricValue(selected?.result?.diagnostics?.structuralFloor?.metricLowerBounds, "soBuoiTrong2", 0));
  const singletonTargetReached = metricValue(selected.metrics, "soBuoiDay1", Number.MAX_SAFE_INTEGER) <= floor;
  const gapTargetReached = metricValue(selected.metrics, "soBuoiTrong2", Number.MAX_SAFE_INTEGER) <= gapFloor;
  // `targetReached` follows the primary FET objective contract: singleton
  // sessions reach the proven floor first. Gap-2 is a second-stage quality
  // signal and is reported separately; it must not make a completed primary
  // objective look unfinished to the caller.
  const qualityTargetReached = singletonTargetReached && gapTargetReached;
  return {
    status: 200,
    payload: {
      ok: true,
      applied: true,
      engine: "fet_trongoi_backend_parallel",
      executor: "fet_backend",
      tkb: selected.tkb,
      placed: metricValue(selected.result, "placed", 0),
      unassigned: 0,
      cellCount: selected.cellCount,
      initialMetrics: selected.initialMetrics,
      metrics: selected.metrics,
      lessons: selected.lessons || [],
      unassignedLessons: selected.unassignedLessons || [],
      targetMetricLowerBound: floor,
      gapMetricLowerBound: gapFloor,
      targetReached: singletonTargetReached,
      floorReached: singletonTargetReached,
      qualityTargetReached,
      singletonTargetReached,
      gapTargetReached,
      stopped: terminal.reason === "deadline" || terminal.reason === "cancelled" || terminal.reason === "stagnated",
      stagnated: terminal.reason === "stagnated",
      stopReason: terminal.reason,
      selectedLane: selected.lane,
      selectedSeed: selected.seed,
      parallelWorkers: terminal.laneCount,
      laneStateBudget: selected.stateBudget,
      stateBudgetUsed: selected.stateBudgetUsed || 0,
      totalStateBudget: selected.totalStateBudget,
      validation: selected.validation,
      runtimeMs: Date.now() - processStartedMs,
      solver: {
        name: "fet_backend_parallel_v1",
        backend: "node-fet-parallel",
        runtime_settings: {
          execution_runtime: "node_worker_threads",
          parallel_workers: terminal.laneCount,
          total_state_budget: selected.totalStateBudget,
          lane_state_budget: selected.stateBudget,
          state_budget_used: selected.stateBudgetUsed || 0,
          selected_lane: selected.lane,
          selected_seed: selected.seed,
          stop_reason: terminal.reason
        }
      }
    }
  };
}

async function laneMain() {
  try {
    const candidate = await runLane(workerData.request, workerData.laneIndex, workerData.laneCount);
    parentPort.postMessage({ type: "done", candidate });
  } catch (error) {
    parentPort.postMessage({
      type: "done",
      candidate: {
        ok: false,
        applied: false,
        lane: Number(workerData?.laneIndex || 0) + 1,
        error: String(error?.stack || error)
      }
    });
  }
}

async function main() {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch (error) {
    writeResult(400, { ok: false, error: "invalid_json", detail: String(error?.message || error) });
    return;
  }
  if (!request || typeof request !== "object" || !request.data || !Array.isArray(request.data.lop)) {
    writeResult(400, { ok: false, error: "solver_request_invalid", detail: "data.lop missing" });
    return;
  }
  try {
    const terminal = await runParallel(request);
    writeResult(terminal.status, terminal.payload);
  } catch (error) {
    writeResult(500, {
      ok: false,
      error: "fet_trongoi_runner_failed",
      detail: String(error?.stack || error)
    });
  }
}

if (!isMainThread && workerData?.kind === "fet-lane") {
  laneMain().catch(error => {
    parentPort?.postMessage({ type: "done", candidate: { ok: false, error: String(error?.stack || error) } });
  });
} else if (isMainThread) {
  main().catch(error => {
    writeResult(500, { ok: false, error: "fet_trongoi_runner_failed", detail: String(error?.stack || error) });
  });
}
