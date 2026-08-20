/**
 * TKB FET Background Worker
 * Runs FetTimetableEngine on a dedicated background CPU thread
 * Guarantees 60 FPS smooth UI and instant cancellation
 */

// Import the FET engine into worker scope with cache buster
importScripts('tkb-fet-engine.js?v=' + Date.now());

let currentEngine = null;

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, Math.round(resolved)));
}

function optimizerMetricsFromProgress(progress) {
  if (progress?.metrics && typeof progress.metrics === 'object') return progress.metrics;
  if (progress && typeof progress === 'object' && Number.isFinite(Number(progress.soBuoiDay1))) return progress;
  return null;
}

function emitOptimizerProgress(cb, progress, config) {
  const metrics = optimizerMetricsFromProgress(progress);
  const rawPercent = Number(progress?.percent);
  const boundedPercent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : 0;
  const metricKey = config.metricKey;
  cb({
    percent: config.basePercent + Math.round(boundedPercent * config.percentSpan / 100),
    currentMetric: progress?.currentMetric ?? metrics?.[metricKey] ?? config.initialMetrics?.[metricKey],
    initialMetric: progress?.initialMetric ?? config.initialMetrics?.[metricKey],
    stage: progress?.stage || config.stage,
    cycle: config.cycle,
    pass: progress?.pass,
    maxPasses: progress?.maxPasses,
    metrics
  });
}

async function runSolveOptimizeAllImpl(cb, data, workerOptions, setEngine, isConstruction) {
  const baseSeed = Number(workerOptions.seed) || 28183;
  const MAX_ATTEMPTS = 5;
  const ATTEMPT_DEADLINE_MS = Date.now() + 15000;
  let bestEngine = null;
  let bestRes = null;
  if (workerOptions.__incumbentComplete === true) {
    const eng = new self.FetTimetableEngine(JSON.parse(JSON.stringify(data)), workerOptions);
    setEngine(eng);
    eng.loadExistingSchedule();
    bestEngine = eng;
    bestRes = {
      ok: true,
      applied: true,
      placed: eng.activities.length,
      unassigned: 0,
      total: eng.activities.length
    };
    cb({
      percent: 35,
      currentMetric: eng.evaluateMetrics().soBuoiDay1,
      initialMetric: eng.evaluateMetrics().soBuoiDay1,
      stage: 'singleton_priority',
      metrics: eng.evaluateMetrics()
    });
  } else {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      isConstruction(true);
      const engineData = JSON.parse(JSON.stringify(data));
      const eng = new self.FetTimetableEngine(engineData, Object.assign({}, workerOptions, { seed: baseSeed + attempt * 7919 }));
      setEngine(eng);
      const res = await eng.solve((p) => {
        cb({
          percent: Math.round(Math.min(100, Number(p.percent) || 0) * 0.35),
          currentMetric: Number(p.placed) || 0,
          initialMetric: Number(p.total) || 0,
          stage: 'construction',
          metrics: null
        });
      });
      try { eng.getSnapshotTKB(); } catch (_) {}
      isConstruction(false);
      const un = (res && res.ok !== false) ? (Number(res.unassigned) || 0) : Number.MAX_SAFE_INTEGER;
      const bestUn = bestRes ? ((bestRes.ok !== false) ? (Number(bestRes.unassigned) || 0) : Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (!bestRes || un < bestUn) { bestEngine = eng; bestRes = res; }
      if (un === 0) break;
      if (Date.now() > ATTEMPT_DEADLINE_MS) break;
    }
  }
  setEngine(bestEngine);
  const bestUnassigned = (bestRes && bestRes.ok !== false) ? (Number(bestRes.unassigned) || 0) : 0;

  if (bestEngine && bestUnassigned === 0) {
    const initialMetrics = bestEngine.evaluateMetrics();
    const singletonFloor = Number(bestEngine.constraintPreflight?.structuralFloor?.metricLowerBounds?.soBuoiDay1 || 0);
    const qualityBudgetMs = clampNumber(workerOptions.autoQualityTimeBudgetMs, 60_000, 12_000, 180_000);
    const singletonCycleBudgetMs = clampNumber(workerOptions.singletonCycleBudgetMs, 20_000, 5_000, 60_000);
    const qualityDeadline = Date.now() + qualityBudgetMs;
    let currentMetrics = initialMetrics;
    let singletonResult = null;
    let noImprovementCycles = 0;
    let cycle = 0;

    cb({
      percent: 35,
      currentMetric: currentMetrics.soBuoiDay1,
      initialMetric: initialMetrics.soBuoiDay1,
      stage: 'singleton_priority',
      cycle: 0,
      metrics: currentMetrics
    });

    while (currentMetrics.soBuoiDay1 > singletonFloor && Date.now() < qualityDeadline) {
      cycle++;
      const beforeSingletons = currentMetrics.soBuoiDay1;
      const remainingMs = qualityDeadline - Date.now();
      if (remainingMs < 250) break;

      bestEngine.tabuMap?.clear?.();
      bestEngine.triedRemovals?.clear?.();
      bestEngine.swappedInBranch?.clear?.();
      bestEngine.nCalls = 0;

      singletonResult = await bestEngine.runUntilZeroSingletons({
        timeBudgetMs: Math.min(singletonCycleBudgetMs, remainingMs),
        maxPasses: clampNumber(workerOptions.singletonMaxPasses, 30, 8, 60),
        stagnationThreshold: clampNumber(workerOptions.singletonStagnationThreshold, 6, 2, 15),
        onProgress: (progress) => emitOptimizerProgress(cb, progress, {
          basePercent: 35,
          percentSpan: 50,
          stage: 'singleton_priority',
          cycle,
          metricKey: 'soBuoiDay1',
          initialMetrics
        })
      });
      currentMetrics = bestEngine.evaluateMetrics();
      cb({
        percent: Math.min(85, 35 + cycle * 8),
        currentMetric: currentMetrics.soBuoiDay1,
        initialMetric: initialMetrics.soBuoiDay1,
        stage: 'singleton_priority',
        cycle,
        metrics: currentMetrics
      });

      if (currentMetrics.soBuoiDay1 < beforeSingletons) noImprovementCycles = 0;
      else noImprovementCycles++;
      if (noImprovementCycles >= 2) break;
    }

    let finalResult = singletonResult || {
      ok: true,
      applied: true,
      initialMetrics,
      metrics: currentMetrics,
      placed: bestEngine.activities.length,
      unassigned: 0,
      diagnostics: bestEngine.constraintPreflight
    };

    // Singleton quality is the first priority. Do not spend the remaining
    // budget on secondary objectives until it reaches zero or a proven floor.
    if (currentMetrics.soBuoiDay1 <= singletonFloor && Date.now() < qualityDeadline) {
      const gapInitialMetrics = currentMetrics;
      if (currentMetrics.soBuoiTrong2 > 0) {
        const gapResult = await bestEngine.optimize('optimize_gap2', (progress) => {
          emitOptimizerProgress(cb, progress, {
            basePercent: 85,
            percentSpan: 10,
            stage: 'gap2_priority',
            cycle: 1,
            metricKey: 'soBuoiTrong2',
            initialMetrics: gapInitialMetrics
          });
        });
        if (gapResult) finalResult = gapResult;
        currentMetrics = bestEngine.evaluateMetrics();
      }

      if (currentMetrics.soBuoiTrong2 === 0 && Date.now() < qualityDeadline) {
        const remainingMs = qualityDeadline - Date.now();
        bestEngine.options.optimizeTimeBudgetMs = Math.max(250, remainingMs);
        const polishInitialMetrics = currentMetrics;
        const polishResult = await bestEngine.optimizeAll((progress) => {
          emitOptimizerProgress(cb, progress, {
            basePercent: 95,
            percentSpan: 5,
            stage: 'quality_polish',
            cycle: 1,
            metricKey: 'soBuoiDay1',
            initialMetrics: polishInitialMetrics
          });
        });
        if (polishResult) finalResult = polishResult;
        currentMetrics = bestEngine.evaluateMetrics();
      }
    }

    const out = finalResult || {};
    out.initialMetrics = initialMetrics;
    out.metrics = currentMetrics;
    out.placed = Number(bestRes?.placed) || bestEngine.activities.length;
    out.unassigned = 0;
    out.ok = true;
    out.applied = true;
    out.targetMetric = 'soBuoiDay1';
    out.targetMetricKey = 'soBuoiDay1';
    out.targetMetricLowerBound = singletonFloor;
    out.targetReached = currentMetrics.soBuoiDay1 <= singletonFloor;
    out.floorReached = currentMetrics.soBuoiDay1 <= singletonFloor;
    // Keep a truthful signal for the UI when the time/stagnation budget ends
    // before the proven floor is reached. This is distinct from a mathematical
    // floor: the latter is reported through floorReached.
    out.stagnated = currentMetrics.soBuoiDay1 > singletonFloor;
    out.diagnostics = bestEngine.constraintPreflight;
    return out;
  }

  return {
    ok: true,
    applied: true,
    placed: Number(bestRes?.placed) || (bestEngine ? bestEngine.activities.length - bestUnassigned : 0),
    unassigned: bestUnassigned,
    total: bestEngine?.activities?.length || 0,
    metrics: bestEngine?.evaluateMetrics?.() || null,
    initialMetrics: null
  };
}

self.onmessage = async function(e) {
  const taskType = e.data?.action || e.data?.type;
  const { mode, data, options } = e.data || {};

  try {
    const workerOptions = Object.assign({ uiBreathingMs: 0 }, options || {});
    currentEngine = new self.FetTimetableEngine(data, workerOptions);

    let res;
    let constructionPhase = false;
    const runSolveOptimizeAll = (cb) => runSolveOptimizeAllImpl(
      cb,
      data,
      workerOptions,
      (eng) => { if (eng) currentEngine = eng; },
      (v) => { constructionPhase = !!v; }
    );

    let bestCheckpoint = null;
    let lastSnapshotAt = 0;
    const SNAPSHOT_INTERVAL_MS = 250;
    if (taskType === 'optimize') {
      const initialMetrics = currentEngine.evaluateMetrics();
      const res = await currentEngine.optimize(mode, (prog) => {
        let normalized = null;
        emitOptimizerProgress((value) => { normalized = value; }, prog, {
          basePercent: 0,
          percentSpan: 100,
          stage: mode,
          cycle: prog?.cycle,
          metricKey: mode === 'optimize_gap2' ? 'soBuoiTrong2' : (mode === 'optimize_gap1' ? 'soBuoiTrong1' : (mode === 'optimize_sessions' ? 'tsBuoiDay' : 'soBuoiDay1')),
          initialMetrics
        });
        if (!normalized) normalized = { metrics: initialMetrics, currentMetric: initialMetrics.soBuoiDay1, initialMetric: initialMetrics.soBuoiDay1, stage: mode, percent: 0 };
        let snapshotTkb = null;
        if (!constructionPhase) {
          const now = Date.now();
          if (!bestCheckpoint || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || (normalized && normalized.percent >= 100)) {
            try {
              const snap = typeof currentEngine.getRetainedOptimizationSnapshotTKB === 'function'
                ? currentEngine.getRetainedOptimizationSnapshotTKB()
                : currentEngine.getSnapshotTKB();
              lastSnapshotAt = now;
              bestCheckpoint = {
                complete: Number(normalized?.metrics?.unplacedCount || 0) === 0,
                tkb: snap,
                metrics: normalized?.metrics
              };
            } catch (_) {}
          }
          snapshotTkb = bestCheckpoint ? bestCheckpoint.tkb : null;
        }

        self.postMessage({
          type: 'progress',
          mode: mode,
          percent: normalized.percent,
          pass: normalized.pass,
          maxPasses: normalized.maxPasses,
          currentMetric: normalized.currentMetric,
          initialMetric: normalized.initialMetric,
          stage: normalized.stage || null,
          cycle: normalized.cycle,
          metrics: normalized.metrics,
          checkpoint: bestCheckpoint,
          tkb: snapshotTkb
        });
      });

      const finalSnapshot = typeof currentEngine.getRetainedOptimizationSnapshotTKB === 'function'
        ? currentEngine.getRetainedOptimizationSnapshotTKB()
        : currentEngine.getSnapshotTKB();

      self.postMessage({
        type: 'done',
        ok: res && res.ok !== false,
        applied: true,
        tkb: finalSnapshot,
        initialMetrics: res?.initialMetrics,
        metrics: res?.metrics,
        targetMetric: res?.targetMetric,
        targetMetricKey: res?.targetMetricKey,
        targetMetricLowerBound: res?.targetMetricLowerBound,
        targetReached: res?.targetReached,
        floorReached: res?.floorReached,
        stagnated: res?.stagnated,
        placed: res?.placed,
        unassigned: res?.unassigned,
        total: res?.total || ((res?.placed || 0) + (res?.unassigned || 0))
      });
      return;
    } else {
      const isSolveOptMode = mode === 'solve_optimize_all' || mode === 'solve_optimize_all_fresh' || mode === 'auto' || taskType === 'solve';
      if (isSolveOptMode) {
        res = await runSolveOptimizeAll((prog) => {
          let snapshotTkb = null;
          if (!constructionPhase) {
            const now = Date.now();
            if (!bestCheckpoint || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || (prog && prog.percent >= 100)) {
              try {
                const snap = typeof currentEngine.getRetainedOptimizationSnapshotTKB === 'function'
                  ? currentEngine.getRetainedOptimizationSnapshotTKB()
                  : currentEngine.getSnapshotTKB();
                lastSnapshotAt = now;
                bestCheckpoint = {
                  complete: Number(prog?.metrics?.unplacedCount || 0) === 0,
                  tkb: snap,
                  metrics: prog?.metrics
                };
              } catch (_) {}
            }
            snapshotTkb = bestCheckpoint ? bestCheckpoint.tkb : null;
          }

          self.postMessage({
            type: 'progress',
            mode: mode,
            percent: prog?.percent,
            currentMetric: prog?.currentMetric,
            initialMetric: prog?.initialMetric,
            stage: prog?.stage || null,
            cycle: prog?.cycle,
            metrics: prog?.metrics,
            checkpoint: bestCheckpoint,
            tkb: snapshotTkb
          });
        });
      } else {
        res = await currentEngine.solve((prog) => {
          self.postMessage({
            type: 'progress',
            mode: mode,
            percent: prog?.percent,
            currentMetric: prog?.currentMetric,
            initialMetric: prog?.initialMetric,
            stage: prog?.stage || null,
            cycle: prog?.cycle,
            metrics: prog?.metrics,
            checkpoint: null,
            tkb: null
          });
        });
      }

      const finalSnapshot = typeof currentEngine.getRetainedOptimizationSnapshotTKB === 'function'
        ? currentEngine.getRetainedOptimizationSnapshotTKB()
        : currentEngine.getSnapshotTKB();

      self.postMessage({
        type: 'done',
        ok: res && res.ok !== false,
        applied: res && res.applied !== false,
        tkb: finalSnapshot,
        initialMetrics: res?.initialMetrics,
        metrics: res?.metrics,
        placed: res?.placed,
        unassigned: res?.unassigned,
        total: res?.total || ((res?.placed || 0) + (res?.unassigned || 0))
      });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: err?.message || String(err)
    });
  }
};
