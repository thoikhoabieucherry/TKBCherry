/**
 * TKBCherry FET browser worker.
 *
 * Construction and optimization are intentionally separate:
 * - construct: find the first complete hard-valid timetable, with short
 *   FET-style seed restarts;
 * - optimize: improve exactly the metric selected by the user, then stop at
 *   its floor, deadline, or first plateau.
 *
 * There is no server solver and no hidden "solve + ten-minute polish" lane.
 */

importScripts('tkb-fet-engine.js?v=' + Date.now());

let currentEngine = null;

const OPTIMIZE_MODES = new Set([
  'optimize_singletons',
  'optimize_sessions',
  'optimize_gap2',
  'optimize_gap1'
]);

const OPTIMIZE_BUDGETS_MS = Object.freeze({
  optimize_singletons: 12_000,
  optimize_sessions: 8_000,
  optimize_gap2: 8_000,
  optimize_gap1: 8_000
});

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, Math.round(resolved)));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function metricKeyForMode(mode) {
  if (mode === 'optimize_sessions') return 'tsBuoiDay';
  if (mode === 'optimize_gap2') return 'soBuoiTrong2';
  if (mode === 'optimize_gap1') return 'soBuoiTrong1';
  return 'soBuoiDay1';
}

function normalizeOptimizerProgress(progress, mode, initialMetrics) {
  const metrics = progress?.metrics && typeof progress.metrics === 'object'
    ? progress.metrics
    : null;
  const key = metricKeyForMode(mode);
  return {
    percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
    pass: progress?.pass,
    maxPasses: progress?.maxPasses,
    currentMetric: progress?.currentMetric ?? metrics?.[key] ?? initialMetrics?.[key],
    initialMetric: progress?.initialMetric ?? initialMetrics?.[key],
    stage: progress?.stage || mode,
    metrics,
    targetMetricLowerBound: progress?.targetMetricLowerBound,
    heartbeat: Boolean(progress?.heartbeat),
    sessionStates: progress?.sessionStates,
    periodStates: progress?.periodStates,
    stateBudget: progress?.stateBudget,
    elapsedMs: progress?.elapsedMs
  };
}

function snapshotTimetable(engine) {
  return typeof engine?.getRetainedOptimizationSnapshotTKB === 'function'
    ? engine.getRetainedOptimizationSnapshotTKB()
    : engine.getSnapshotTKB();
}

function compareForMode(engine, candidate, incumbent, baseline, mode) {
  if (!candidate) return 1;
  if (!incumbent) return -1;
  if (typeof engine?.compareMetrics === 'function') {
    return engine.compareMetrics(candidate, incumbent, baseline || incumbent, mode);
  }
  const key = metricKeyForMode(mode);
  return Number(candidate[key] || 0) - Number(incumbent[key] || 0);
}

async function runFastConstruction(data, rawOptions, onProgress) {
  const options = Object.assign({}, rawOptions || {});
  const totalBudgetMs = clampNumber(
    options.constructionTimeBudgetMs ?? options.timeBudgetMs,
    12_000,
    1_000,
    30_000
  );
  const maxAttempts = clampNumber(options.constructionAttempts, 3, 1, 5);
  const startedAt = Date.now();
  const deadlineAt = startedAt + totalBudgetMs;
  const requestedSeed = Number(options.seed);
  const baseSeed = Number.isFinite(requestedSeed) && requestedSeed !== 0
    ? Math.trunc(requestedSeed)
    : (Date.now() & 0x7fffffff);
  let bestEngine = null;
  let bestResult = null;
  let attempts = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 250) break;
    attempts++;
    const attemptsLeft = maxAttempts - attempt;
    // Let the MRV-first seed do real work, while reserving two short FET-style
    // permutation restarts for a local minimum. With the 12 s profile this is
    // approximately 7.2 s + 2.4 s + 2.4 s.
    const attemptShare = attempt === 0 && attemptsLeft > 1 ? 0.60 : (1 / attemptsLeft);
    const attemptBudgetMs = Math.max(250, Math.floor(remainingMs * attemptShare));
    const engineOptions = Object.assign({}, options, {
      seed: baseSeed + attempt * 104729,
      timeBudgetMs: attemptBudgetMs,
      constructionPolishTimeBudgetMs: clampNumber(
        options.constructionPolishTimeBudgetMs,
        250,
        0,
        1_000
      ),
      // The four explicit buttons own quality work. Construction should
      // publish as soon as all activities are validly placed.
      initialSingletonPacking: false
    });
    const engine = new self.FetTimetableEngine(clone(data), engineOptions);
    currentEngine = engine;
    const result = await engine.solve(progress => {
      onProgress({
        percent: Number(progress?.percent) || 0,
        placed: Number(progress?.placed) || 0,
        total: Number(progress?.total) || engine.activities.length,
        currentMetric: Number(progress?.placed) || 0,
        initialMetric: Number(progress?.total) || engine.activities.length,
        stage: 'construction',
        attempt: attempt + 1,
        maxAttempts
      });
    });

    const unassigned = result?.ok === false
      ? Number(result?.unassigned ?? engine.getUnassignedCount?.() ?? Number.MAX_SAFE_INTEGER)
      : Number(result?.unassigned || 0);
    const bestUnassigned = bestResult
      ? Number(bestResult?.unassigned ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    if (!bestResult || unassigned < bestUnassigned) {
      bestEngine = engine;
      bestResult = result;
    }
    if (result?.ok === true && result?.applied !== false && unassigned === 0) break;
    if ([
      'fet_zero_domain',
      'fet_capacity_shortage',
      'fet_fixed_location_constraint_violation',
      'fet_must_teach_unmet'
    ].includes(result?.failureKind)) break;
  }

  currentEngine = bestEngine || currentEngine;
  return {
    engine: currentEngine,
    result: bestResult || {
      ok: false,
      applied: false,
      failureKind: 'fet_construction_budget_exhausted',
      placed: 0,
      unassigned: 0,
      total: 0
    },
    timing: {
      phase: 'construction',
      attempts,
      budgetMs: totalBudgetMs,
      elapsedMs: Date.now() - startedAt
    }
  };
}

async function runFocusedOptimization(data, mode, rawOptions) {
  const options = Object.assign({}, rawOptions || {});
  const fallbackBudgetMs = OPTIMIZE_BUDGETS_MS[mode] || 8_000;
  options.optimizeTimeBudgetMs = clampNumber(
    options.optimizeTimeBudgetMs,
    fallbackBudgetMs,
    1_000,
    20_000
  );
  const startedAt = Date.now();
  const engine = new self.FetTimetableEngine(clone(data), options);
  currentEngine = engine;
  engine.loadExistingSchedule();
  engine.compileConstraints();

  const initialMetrics = engine.evaluateMetrics();
  let bestMetrics = { ...initialMetrics };
  let bestCheckpoint = null;
  let lastSnapshotAt = 0;
  const snapshotIntervalMs = 750;

  const result = await engine.optimize(mode, progress => {
    const normalized = normalizeOptimizerProgress(progress, mode, initialMetrics);
    const metrics = normalized.metrics;
    const now = Date.now();
    if (metrics && Number(metrics.unplacedCount || 0) === 0
      && compareForMode(engine, metrics, bestMetrics, initialMetrics, mode) < 0
      && (now - lastSnapshotAt >= snapshotIntervalMs || normalized.percent >= 100)) {
      bestMetrics = { ...metrics };
      lastSnapshotAt = now;
      bestCheckpoint = {
        complete: true,
        tkb: snapshotTimetable(engine),
        metrics: bestMetrics
      };
    }
    self.postMessage(Object.assign({
      type: 'progress',
      mode,
      checkpoint: normalized.heartbeat ? null : bestCheckpoint,
      tkb: null
    }, normalized));
  });

  return {
    engine,
    result,
    initialMetrics,
    timing: {
      phase: 'optimization',
      mode,
      budgetMs: options.optimizeTimeBudgetMs,
      elapsedMs: Date.now() - startedAt
    }
  };
}

function startHeartbeat(mode, startedAt) {
  return setInterval(() => {
    if (!currentEngine) return;
    try {
      const metrics = currentEngine.evaluateMetrics();
      self.postMessage({
        type: 'progress',
        mode,
        percent: 0,
        currentMetric: metrics[metricKeyForMode(mode)],
        initialMetric: null,
        stage: mode,
        metrics,
        heartbeat: true,
        elapsedMs: Date.now() - startedAt,
        checkpoint: null,
        tkb: null
      });
    } catch (_) {}
  }, 750);
}

self.onmessage = async function(event) {
  const message = event?.data || {};
  const taskType = String(message.action || message.type || 'construct');
  const mode = String(message.mode || 'solve_fast');
  const data = message.data || {};
  const options = Object.assign({ uiBreathingMs: 0 }, message.options || {});
  const startedAt = Date.now();
  let heartbeatTimer = null;

  try {
    if (taskType === 'optimize' && OPTIMIZE_MODES.has(mode)) {
      heartbeatTimer = startHeartbeat(mode, startedAt);
      const output = await runFocusedOptimization(data, mode, options);
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const result = output.result || {};
      self.postMessage({
        type: 'done',
        ok: result.ok !== false,
        applied: result.applied !== false,
        tkb: snapshotTimetable(output.engine),
        initialMetrics: result.initialMetrics || output.initialMetrics,
        metrics: result.metrics || output.engine.evaluateMetrics(),
        targetMetric: result.targetMetric,
        targetMetricKey: result.targetMetricKey,
        targetMetricLowerBound: result.targetMetricLowerBound,
        targetReached: result.targetReached,
        floorReached: result.floorReached,
        stagnated: result.stagnated,
        residualSingletons: result.residualSingletons || [],
        singletonRegressionReverted: result.singletonRegressionReverted === true,
        placed: result.placed,
        unassigned: result.unassigned,
        total: result.total || ((result.placed || 0) + (result.unassigned || 0)),
        diagnostics: result.diagnostics || null,
        timing: output.timing
      });
      return;
    }

    // Legacy solve_optimize_all/auto messages intentionally land here too.
    // They now mean "construct quickly"; quality work is only user-triggered.
    const output = await runFastConstruction(data, options, progress => {
      self.postMessage(Object.assign({
        type: 'progress',
        mode: 'solve_fast',
        checkpoint: null,
        tkb: null,
        heartbeat: false
      }, progress));
    });
    const result = output.result || {};
    self.postMessage({
      type: 'done',
      ok: result.ok === true,
      applied: result.applied !== false,
      tkb: output.engine ? output.engine.getSnapshotTKB() : null,
      initialMetrics: null,
      metrics: output.engine?.evaluateMetrics?.() || null,
      placed: result.placed,
      unassigned: result.unassigned,
      total: result.total || ((result.placed || 0) + (result.unassigned || 0)),
      diagnostics: result.diagnostics || null,
      failureKind: result.failureKind || null,
      timing: output.timing
    });
  } catch (error) {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    self.postMessage({
      type: 'error',
      error: error?.message || String(error)
    });
  }
};
