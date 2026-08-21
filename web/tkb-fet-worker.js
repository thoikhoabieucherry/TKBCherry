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
    metrics,
    targetMetricLowerBound: config.targetMetricLowerBound ?? progress?.targetMetricLowerBound,
    heartbeat: Boolean(progress?.heartbeat),
    sessionStates: progress?.sessionStates,
    periodStates: progress?.periodStates,
    stateBudget: progress?.stateBudget,
    elapsedMs: progress?.elapsedMs
  });
}

function compareParallelQuality(candidate, incumbent) {
  if (!candidate || !incumbent) return candidate ? -1 : 0;
  const keys = ['unplacedCount', 'soBuoiDay1', 'soBuoiTrong2', 'tsBuoiDay', 'soBuoiTrong1', 'tsNgayDay'];
  for (const key of keys) {
    const a = Number(candidate[key] || 0);
    const b = Number(incumbent[key] || 0);
    if (a !== b) return a - b;
  }
  return 0;
}

async function runParallelConstructionLane(cb, data, workerOptions, baseSeed) {
  if (typeof Worker !== 'function') return null;
  const requestedWorkers = Number(workerOptions.parallelConstructionWorkers ?? workerOptions.parallelWorkers);
  const workerCount = Number.isFinite(requestedWorkers) && requestedWorkers > 1
    ? clampNumber(requestedWorkers, 2, 2, 4)
    : 1;
  if (workerCount <= 1) return null;

  const constructionBudgetMs = clampNumber(
    workerOptions.parallelConstructionTimeBudgetMs,
    30_000,
    5_000,
    120_000
  );
  const children = [];
  let completed = 0;
  let lastProgressAt = 0;
  let best = null;

  const result = await new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const child of children) {
        try { child.terminate(); } catch (_) {}
      }
      resolve(best);
    };

    const onChildMessage = (event, index) => {
      const msg = event?.data || {};
      if (msg.type === 'progress') {
        const now = Date.now();
        if (now - lastProgressAt >= 500) {
          lastProgressAt = now;
          cb({
            percent: Math.round(Math.max(0, Math.min(100, Number(msg.percent) || 0)) * 0.35),
            currentMetric: msg.currentMetric,
            initialMetric: msg.initialMetric,
            stage: 'construction',
            cycle: index + 1,
            metrics: null
          });
        }
        return;
      }
      if (msg.type !== 'done') return;
      completed++;

      const unassigned = Number(msg.unassigned || 0);
      if (msg.ok === true && msg.tkb && unassigned === 0) {
        const candidateData = JSON.parse(JSON.stringify(data));
        candidateData.tkb = msg.tkb;
        const candidateEngine = new self.FetTimetableEngine(candidateData, Object.assign({}, workerOptions, {
          parallelWorkers: 1,
          parallelConstructionWorkers: 1
        }));
        candidateEngine.loadExistingSchedule();
        candidateEngine.compileConstraints();
        best = {
          engine: candidateEngine,
          metrics: candidateEngine.evaluateMetrics(),
          result: {
            ok: true,
            applied: true,
            placed: Number(msg.placed) || candidateEngine.activities.length,
            unassigned: 0,
            total: Number(msg.total) || candidateEngine.activities.length
          }
        };
        // A complete construction is enough to enter the normal quality lane.
        // Do not wait for slower seeds once the first valid schedule is ready.
        finish();
        return;
      }
      if (completed >= workerCount) finish();
    };

    timer = setTimeout(finish, constructionBudgetMs + 1_000);
    for (let index = 0; index < workerCount; index++) {
      try {
        const child = new Worker('tkb-fet-worker.js?v=' + Date.now() + '-construction-' + index);
        children.push(child);
        child.onmessage = event => onChildMessage(event, index);
        child.onerror = () => {
          completed++;
          if (completed >= workerCount) finish();
        };
        child.postMessage({
          action: 'solve',
          mode: 'solve',
          data: JSON.parse(JSON.stringify(data)),
          options: Object.assign({}, workerOptions, {
            seed: baseSeed + 104729 * (index + 1),
            parallelWorkers: 1,
            parallelConstructionWorkers: 1,
            parallelRestartSliceMs: 0,
            timeBudgetMs: constructionBudgetMs
          })
        });
      } catch (_) {
        completed++;
      }
    }
    if (children.length === 0) finish();
  });

  if (!result?.engine) return children.length > 0 ? { attempted: true } : null;
  return result;
}

async function runParallelRestartLane(cb, data, workerOptions, baseSeed, incumbentMetrics, singletonFloor, qualityDeadline) {
  if (typeof Worker !== 'function') return null;
  const requestedWorkers = Number(workerOptions.parallelWorkers);
  const workerCount = Number.isFinite(requestedWorkers) && requestedWorkers > 1
    ? clampNumber(requestedWorkers, 2, 2, 6)
    : 1;
  if (workerCount <= 1) return null;

  const remainingMs = Math.max(0, qualityDeadline - Date.now());
  if (remainingMs < 1_000) return null;
  const sliceMs = clampNumber(workerOptions.parallelRestartSliceMs, 30_000, 5_000, 120_000);
  const childBudgetMs = Math.min(sliceMs, remainingMs);
  const children = [];
  let completed = 0;
  let lastProgressAt = 0;
  let best = null;

  const result = await new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      for (const child of children) {
        try { child.terminate(); } catch (_) {}
      }
      resolve(best);
    };

    const onChildMessage = (event, index) => {
      const msg = event?.data || {};
      if (msg.type === 'progress') {
        const now = Date.now();
        if (now - lastProgressAt >= 500 && msg.metrics) {
          lastProgressAt = now;
          cb({
            percent: 45,
            currentMetric: msg.metrics.soBuoiDay1,
            initialMetric: incumbentMetrics.soBuoiDay1,
            stage: 'parallel_restart',
            cycle: index + 1,
            metrics: msg.metrics,
            targetMetricLowerBound: singletonFloor
          });
        }
        return;
      }
      if (msg.type !== 'done') return;
      completed++;
      const candidateMetrics = msg.metrics && typeof msg.metrics === 'object' ? msg.metrics : null;
      const candidate = candidateMetrics && msg.tkb &&
        Number(msg.unassigned || candidateMetrics.unplacedCount || 0) === 0 &&
        candidateMetrics.soBuoiTrong2 === 0
        ? { metrics: candidateMetrics, tkb: msg.tkb }
        : null;
      if (candidate && compareParallelQuality(candidate.metrics, best?.metrics || incumbentMetrics) < 0) {
        best = candidate;
        cb({
          percent: 60,
          currentMetric: candidate.metrics.soBuoiDay1,
          initialMetric: incumbentMetrics.soBuoiDay1,
          stage: 'parallel_restart',
          cycle: index + 1,
          metrics: candidate.metrics,
          targetMetricLowerBound: singletonFloor
        });
        if (candidate.metrics.soBuoiDay1 <= singletonFloor) finish();
      }
      if (completed >= workerCount) finish();
    };

    timer = setTimeout(finish, childBudgetMs + 1_000);
    for (let index = 0; index < workerCount; index++) {
      try {
        const child = new Worker('tkb-fet-worker.js?v=' + Date.now() + '-' + index);
        children.push(child);
        child.onmessage = event => onChildMessage(event, index);
        child.onerror = () => {
          completed++;
          if (completed >= workerCount) finish();
        };
        child.postMessage({
          action: 'solve',
          mode: 'solve_optimize_all',
          data: JSON.parse(JSON.stringify(data)),
          options: Object.assign({}, workerOptions, {
            seed: baseSeed + 104729 * (index + 1),
            __incumbentComplete: false,
            parallelWorkers: 1,
            autoQualityTimeBudgetMs: childBudgetMs,
            parallelRestartSliceMs: 0
          })
        });
      } catch (_) {
        completed++;
      }
    }
    if (children.length === 0) finish();
  });

  if (!result?.tkb) return children.length > 0 ? { attempted: true } : null;
  const candidateData = JSON.parse(JSON.stringify(data));
  candidateData.tkb = result.tkb;
  const candidateEngine = new self.FetTimetableEngine(candidateData, Object.assign({}, workerOptions, {
    parallelWorkers: 1,
    __incumbentComplete: true
  }));
  candidateEngine.loadExistingSchedule();
  candidateEngine.compileConstraints();
  return { engine: candidateEngine, metrics: candidateEngine.evaluateMetrics() };
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
    eng.compileConstraints();
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
      metrics: eng.evaluateMetrics(),
      targetMetricLowerBound: Number(eng.constraintPreflight?.structuralFloor?.metricLowerBounds?.soBuoiDay1 || 0)
    });
  } else {
    isConstruction(true);
    const parallelConstruction = await runParallelConstructionLane(cb, data, workerOptions, baseSeed);
    isConstruction(false);
    if (parallelConstruction?.engine) {
      bestEngine = parallelConstruction.engine;
      setEngine(bestEngine);
      bestRes = parallelConstruction.result;
    }

    if (!bestEngine) {
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
  }
  setEngine(bestEngine);
  const bestUnassigned = (bestRes && bestRes.ok !== false) ? (Number(bestRes.unassigned) || 0) : 0;

  if (bestEngine && bestUnassigned === 0) {
    const initialMetrics = bestEngine.evaluateMetrics();
    const singletonFloor = Number(bestEngine.constraintPreflight?.structuralFloor?.metricLowerBounds?.soBuoiDay1 || 0);
    // Give the first objective enough room to escape local minima. The old
    // 20s/30-pass budget often stopped at a valid but unchanged singleton
    // count (the common "1t/buổi: 4" plateau in the live school data).
    // The live incumbent needs several closed-chain slices: a successful
    // topology is commonly 4 -> 3 -> 1 -> 0, and each slice must get a fresh
    // deadline so the first accepted chain cannot consume the entire click.
    // Keep Stop responsive through the worker, but reserve enough default
    // time to finish the primary objective instead of reporting a plateau at
    // the first intermediate checkpoint.
    const qualityBudgetMs = clampNumber(workerOptions.autoQualityTimeBudgetMs, 600_000, 12_000, 1_200_000);
    const singletonCycleBudgetMs = clampNumber(workerOptions.singletonCycleBudgetMs, 30_000, 5_000, 120_000);
    // The user's hard target is singleton=0/floor and gap-2=0.  Secondary
    // polish used to consume the remainder of the 600s quality budget even
    // after those targets were already solved.  Keep it opt-in and bounded;
    // a solved timetable should be published immediately by default.
    const qualityPolishTimeBudgetMs = clampNumber(workerOptions.qualityPolishTimeBudgetMs, 0, 0, 60_000);
    const qualityDeadline = Date.now() + qualityBudgetMs;
    let currentMetrics = initialMetrics;
    let singletonResult = null;
    let noImprovementCycles = 0;
    let cycle = 0;

    // Fast deterministic pass before the deeper search. It tries direct
    // moves and short three-step chains into a teacher's already occupied
    // session, which is the cheap "gom các phần tử lẻ" case. If it solves the
    // primary target, the expensive 12-bin search is skipped entirely.
    const initialSingletonFastMs = clampNumber(
      workerOptions.initialSingletonFastMs,
      1_200,
      0,
      5_000
    );
    if(currentMetrics.soBuoiDay1 > singletonFloor
      && initialSingletonFastMs > 0
      && Date.now() < qualityDeadline){
      const fastBudgetMs = Math.min(initialSingletonFastMs, Math.max(0, qualityDeadline - Date.now()));
      bestEngine.deadlineAtMs = Date.now() + fastBudgetMs;
      const fastResult = bestEngine.initialSingletonPacking({
        timeBudgetMs:fastBudgetMs,
        maxAttempts:clampNumber(workerOptions.initialSingletonFastAttempts, 20_000, 1_000, 50_000)
      });
      currentMetrics = bestEngine.evaluateMetrics();
      cb({
        percent:38,
        currentMetric:currentMetrics.soBuoiDay1,
        initialMetric:initialMetrics.soBuoiDay1,
        stage:'singleton_fast',
        cycle:0,
        metrics:currentMetrics,
        targetMetricLowerBound:singletonFloor,
        attempts:Number(fastResult?.attempts || 0),
        elapsedMs:Number(fastResult?.elapsedMs || 0)
      });
    }

    // Give the freshly constructed schedule a short, shallow packing pass
    // before enabling the expensive 12-bin/deep operators. The warmup uses
    // the same singleton objective but keeps the normal construction search
    // profile, so it removes cheap singleton debt without spending the first
    // quality slice exploring deep neighborhoods.
    const initialSingletonWarmupMs = clampNumber(
      workerOptions.initialSingletonWarmupMs,
      5_000,
      0,
      15_000
    );
    if(currentMetrics.soBuoiDay1 > singletonFloor
      && initialSingletonWarmupMs > 0
      && Date.now() < qualityDeadline){
      const savedWarmupOptions = {
        deepLocalFet: bestEngine.options.deepLocalFet,
        deepCycles: bestEngine.options.deepCycles,
        sessionBinChains: bestEngine.options.sessionBinChains,
        reformLessonBlocks: bestEngine.options.reformLessonBlocks,
        allowSingletonGap2Tradeoff: bestEngine.options.allowSingletonGap2Tradeoff
      };
      bestEngine.options.deepLocalFet = false;
      bestEngine.options.deepCycles = 0;
      bestEngine.options.sessionBinChains = false;
      bestEngine.options.reformLessonBlocks = false;
      bestEngine.options.allowSingletonGap2Tradeoff = false;
      const warmupRemainingMs = Math.max(0, qualityDeadline - Date.now());
      await bestEngine.runUntilZeroSingletons({
        timeBudgetMs: Math.min(initialSingletonWarmupMs, warmupRemainingMs),
        maxPasses: clampNumber(workerOptions.initialSingletonWarmupPasses, 15, 1, 30),
        stagnationThreshold: clampNumber(workerOptions.initialSingletonWarmupStagnation, 3, 1, 8),
        onProgress: (progress) => emitOptimizerProgress(cb, progress, {
          basePercent: 35,
          percentSpan: 5,
          stage: 'singleton_warmup',
          cycle: 0,
          metricKey: 'soBuoiDay1',
          initialMetrics,
          targetMetricLowerBound: singletonFloor
        })
      });
      currentMetrics = bestEngine.evaluateMetrics();
      cb({
        percent: 40,
        currentMetric: currentMetrics.soBuoiDay1,
        initialMetric: initialMetrics.soBuoiDay1,
        stage: 'singleton_warmup',
        cycle: 0,
        metrics: currentMetrics,
        targetMetricLowerBound: singletonFloor
      });
      Object.assign(bestEngine.options, savedWarmupOptions);
    }

    // Start the incumbent lane in its strongest 12-bin mode. Lesson-block
    // members may be re-paired, but every accepted transaction revalidates
    // the configured block minima before it is retained.
    bestEngine.options.deepLocalFet = true;
    bestEngine.options.deepCycles = Math.max(Number(bestEngine.options.deepCycles) || 0, 12);
    bestEngine.options.sessionBinChains = true;
    bestEngine.options.reformLessonBlocks = true;
    // The normal incumbent lane must never publish a singleton improvement
    // that increases teacher gap-2 debt. Temporary tradeoff is enabled only
    // inside the explicitly bounded deep-search transaction below.
    bestEngine.options.allowSingletonGap2Tradeoff = false;
    bestEngine.options.sessionFirstStateBudget = clampNumber(
      workerOptions.sessionFirstStateBudget,
      1_000_000,
      10,
      1_000_000_000
    );

    cb({
      percent: 35,
      currentMetric: currentMetrics.soBuoiDay1,
      initialMetric: initialMetrics.soBuoiDay1,
      stage: 'singleton_priority',
      cycle: 0,
      metrics: currentMetrics,
      targetMetricLowerBound: singletonFloor
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
        maxPasses: clampNumber(workerOptions.singletonMaxPasses, 60, 8, 120),
        stagnationThreshold: clampNumber(workerOptions.singletonStagnationThreshold, 12, 2, 30),
        onProgress: (progress) => emitOptimizerProgress(cb, progress, {
          basePercent: 35,
          percentSpan: 50,
          stage: 'singleton_priority',
          cycle,
          metricKey: 'soBuoiDay1',
          initialMetrics,
          targetMetricLowerBound: singletonFloor
        })
      });
      currentMetrics = bestEngine.evaluateMetrics();
      cb({
        percent: Math.min(85, 35 + cycle * 8),
        currentMetric: currentMetrics.soBuoiDay1,
        initialMetric: initialMetrics.soBuoiDay1,
        stage: 'singleton_priority',
        cycle,
        metrics: currentMetrics,
        targetMetricLowerBound: singletonFloor
      });

      if (currentMetrics.soBuoiDay1 < beforeSingletons) noImprovementCycles = 0;
      else noImprovementCycles++;
      if (noImprovementCycles >= 8) break;
    }

    // A focused deep-search phase is deliberately separate from the normal
    // pass. It raises the recursive swap budget and enables deeper FET-style
    // rounds only after the inexpensive operators plateau, so routine solves
    // stay responsive while hard incumbents get a genuine second search.
    if (currentMetrics.soBuoiDay1 > singletonFloor && Date.now() < qualityDeadline) {
      const deepRounds = clampNumber(workerOptions.deepSingletonRounds, 3, 1, 8);
      const tradeoffBaseline = { ...currentMetrics };
      const tradeoffSnapshot = bestEngine.captureStateSnapshot();
      bestEngine.options.deepLocalFet = true;
      bestEngine.options.deepCycles = Math.max(Number(bestEngine.options.deepCycles) || 0, 12);
      bestEngine.options.deepLimitCalls = Math.max(Number(bestEngine.options.deepLimitCalls) || 0, 6000);
      bestEngine.options.allowSingletonGap2Tradeoff = true;
      bestEngine.strictFetGaps = false;
      bestEngine.strictTeacherGaps = false;
      for (let deepRound = 1; deepRound <= deepRounds; deepRound++) {
        if (Date.now() >= qualityDeadline || currentMetrics.soBuoiDay1 <= singletonFloor) break;
        const beforeDeep = currentMetrics.soBuoiDay1;
        const remainingMs = qualityDeadline - Date.now();
        bestEngine.options.optimizeTimeBudgetMs = Math.max(1000, remainingMs);
        bestEngine.tabuMap?.clear?.();
        bestEngine.triedRemovals?.clear?.();
        bestEngine.swappedInBranch?.clear?.();
        bestEngine.nCalls = 0;
        await bestEngine.optimize('optimize_singletons', (progress) => emitOptimizerProgress(cb, progress, {
          basePercent: 60,
          percentSpan: 25,
          stage: 'singleton_priority',
          cycle: cycle + deepRound,
          metricKey: 'soBuoiDay1',
          initialMetrics,
          targetMetricLowerBound: singletonFloor
        }));
        currentMetrics = bestEngine.evaluateMetrics();
        cb({
          percent: Math.min(85, 60 + deepRound * 7),
          currentMetric: currentMetrics.soBuoiDay1,
          initialMetric: initialMetrics.soBuoiDay1,
          stage: 'singleton_priority',
          cycle: cycle + deepRound,
          metrics: currentMetrics,
          targetMetricLowerBound: singletonFloor
        });
        if (currentMetrics.soBuoiDay1 >= beforeDeep && deepRound >= 2) break;
      }
      bestEngine.options.allowSingletonGap2Tradeoff = false;
      bestEngine.strictFetGaps = true;
      bestEngine.strictTeacherGaps = true;
      const deepSingletonImproved = currentMetrics.soBuoiDay1 < tradeoffBaseline.soBuoiDay1;
      if (deepSingletonImproved && currentMetrics.soBuoiTrong2 > 0) {
        await bestEngine.optimize('optimize_gap2', (progress) => emitOptimizerProgress(cb, progress, {
          basePercent: 85,
          percentSpan: 10,
          stage: 'gap2_priority',
          cycle: cycle + 1,
          metricKey: 'soBuoiTrong2',
          initialMetrics: currentMetrics
        }));
        currentMetrics = bestEngine.evaluateMetrics();
      }
      if (!deepSingletonImproved || currentMetrics.soBuoiTrong2 > 0) {
        bestEngine.restoreStateSnapshot(tradeoffSnapshot);
        bestEngine.applyToDataTKB();
        currentMetrics = bestEngine.evaluateMetrics();
      }
    }

    // If local search is still plateaued, try a few independent constructions
    // from the same hard constraints. A complete incumbent can be a genuine
    // local minimum; restarting with a different seed explores a different
    // pairing/session topology. We keep the incumbent unless the candidate is
    // lexicographically better and never trade away a zero gap-2 schedule.
    if (currentMetrics.soBuoiDay1 > singletonFloor && Date.now() < qualityDeadline) {
      const parallelResult = await runParallelRestartLane(
        cb,
        data,
        workerOptions,
        baseSeed,
        currentMetrics,
        singletonFloor,
        qualityDeadline
      );
      if (parallelResult?.engine) {
        bestEngine = parallelResult.engine;
        setEngine(bestEngine);
        currentMetrics = parallelResult.metrics;
        bestRes = { ok: true, applied: true, placed: bestEngine.activities.length, unassigned: 0, total: bestEngine.activities.length };
      }

      // Keep the original single-worker restarts as the compatibility fallback
      // only when nested workers are unavailable.
      if (!parallelResult?.attempted) {
        const restartAttempts = clampNumber(workerOptions.singletonRestartAttempts, 3, 1, 6);
        for (let restart = 0; restart < restartAttempts; restart++) {
        if (Date.now() >= qualityDeadline || currentMetrics.soBuoiDay1 <= singletonFloor) break;
        const remainingMs = qualityDeadline - Date.now();
        const attemptBudget = Math.max(1000, Math.min(25_000, Math.floor(remainingMs / (restartAttempts - restart))));
        const candidateOptions = Object.assign({}, workerOptions, {
          seed: baseSeed + 104729 * (restart + 1),
          deepLocalFet: true,
          deepCycles: Math.max(Number(workerOptions.deepCycles) || 0, 12),
          deepLimitCalls: Math.max(Number(workerOptions.deepLimitCalls) || 0, 6000),
          timeBudgetMs: attemptBudget,
          optimizeTimeBudgetMs: attemptBudget
        });
        const candidateData = JSON.parse(JSON.stringify(data));
        const candidate = new self.FetTimetableEngine(candidateData, candidateOptions);
        isConstruction(true);
        const construction = await candidate.solve((progress) => {
          cb({
            percent: 35 + Math.round(Math.max(0, Math.min(100, Number(progress?.percent) || 0)) * 0.15),
            currentMetric: currentMetrics.soBuoiDay1,
            initialMetric: initialMetrics.soBuoiDay1,
            stage: 'singleton_priority',
            cycle: cycle + restart + 1,
            metrics: currentMetrics,
            targetMetricLowerBound: singletonFloor
          });
        });
        isConstruction(false);
        if (!construction || construction.ok === false || Number(construction.unassigned) > 0) continue;

        candidate.options.allowSingletonGap2Tradeoff = true;
        candidate.strictFetGaps = false;
        candidate.strictTeacherGaps = false;
        await candidate.runUntilZeroSingletons({
          timeBudgetMs: Math.min(attemptBudget, qualityDeadline - Date.now()),
          maxPasses: clampNumber(workerOptions.singletonMaxPasses, 60, 8, 120),
          stagnationThreshold: clampNumber(workerOptions.singletonStagnationThreshold, 12, 2, 30)
        });
        candidate.options.allowSingletonGap2Tradeoff = false;
        candidate.strictFetGaps = true;
        candidate.strictTeacherGaps = true;
        let candidateMetrics = candidate.evaluateMetrics();
        const candidateSingletonImproved = candidateMetrics.soBuoiDay1 < currentMetrics.soBuoiDay1;
        if (candidateSingletonImproved && candidateMetrics.soBuoiTrong2 > 0) {
          await candidate.optimize('optimize_gap2', null);
          candidateMetrics = candidate.evaluateMetrics();
        }
        const improves = candidateSingletonImproved && candidateMetrics.soBuoiTrong2 === 0
          && candidate.compareMetrics(candidateMetrics, currentMetrics, currentMetrics, 'optimize_singletons') < 0;
        if (improves) {
          bestEngine = candidate;
          setEngine(candidate);
          currentMetrics = candidateMetrics;
          bestRes = { ok: true, applied: true, placed: candidate.activities.length, unassigned: 0, total: candidate.activities.length };
          cb({
            percent: 75,
            currentMetric: currentMetrics.soBuoiDay1,
            initialMetric: initialMetrics.soBuoiDay1,
            stage: 'singleton_priority',
            cycle: cycle + restart + 1,
            metrics: currentMetrics,
            targetMetricLowerBound: singletonFloor
          });
        }
        }
      }
      setEngine(bestEngine);
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
      const runHorizontalGapClosure = async () => {
        let gapCycle = 0;
        while (currentMetrics.soBuoiDay1 <= singletonFloor && currentMetrics.soBuoiTrong2 > 0 && Date.now() < qualityDeadline) {
          const beforeGap2 = currentMetrics.soBuoiTrong2;
          const remainingMs = qualityDeadline - Date.now();
          if (remainingMs < 250) break;
          gapCycle++;
          bestEngine.options.allowSingletonGap2Tradeoff = false;
          bestEngine.options.reformLessonBlocks = true;
          bestEngine.strictFetGaps = true;
          bestEngine.strictTeacherGaps = true;
          bestEngine.deadlineAtMs = Date.now() + Math.min(90_000, remainingMs);
          await bestEngine.trySessionBinAugmentingChains(currentMetrics, (progress) => emitOptimizerProgress(cb, progress, {
            basePercent: 85,
            percentSpan: 8,
            stage: 'gap2_priority',
            cycle: gapCycle,
            metricKey: 'soBuoiTrong2',
            initialMetrics: currentMetrics
          }));
          currentMetrics = bestEngine.evaluateMetrics();
          cb({
            percent: Math.min(93, 85 + gapCycle * 2),
            currentMetric: currentMetrics.soBuoiTrong2,
            initialMetric: beforeGap2,
            stage: 'gap2_priority',
            cycle: gapCycle,
            metrics: currentMetrics,
            targetMetricLowerBound: 0
          });
          if (currentMetrics.soBuoiDay1 > singletonFloor || currentMetrics.soBuoiTrong2 >= beforeGap2) break;
        }
      };

      // The same 12-bin vacancy chain that merged the singleton rows is the
      // most direct way to close the temporary long gaps it created. Run it
      // before and, if needed, after the generic gap operators.
      await runHorizontalGapClosure();
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
        if (currentMetrics.soBuoiTrong2 > 0 && Date.now() < qualityDeadline) {
          await runHorizontalGapClosure();
        }
      }

      if (currentMetrics.soBuoiTrong2 === 0 && qualityPolishTimeBudgetMs > 0 && Date.now() < qualityDeadline) {
        const remainingMs = qualityDeadline - Date.now();
        bestEngine.options.optimizeTimeBudgetMs = Math.max(250, Math.min(qualityPolishTimeBudgetMs, remainingMs));
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
  let cleanupBackgroundHeartbeat = () => {};

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
    const SNAPSHOT_INTERVAL_MS = 1000;
    let backgroundHeartbeatTimer = null;
    let backgroundHeartbeatStartedAt = 0;
    let backgroundHeartbeatInitialMetric = null;
    const stopBackgroundHeartbeat = () => {
      if(backgroundHeartbeatTimer !== null){
        clearInterval(backgroundHeartbeatTimer);
        backgroundHeartbeatTimer = null;
      }
    };
    cleanupBackgroundHeartbeat = stopBackgroundHeartbeat;
    const startBackgroundHeartbeat = heartbeatMode => {
      stopBackgroundHeartbeat();
      backgroundHeartbeatStartedAt = Date.now();
      backgroundHeartbeatInitialMetric = null;
      backgroundHeartbeatTimer = setInterval(() => {
        if(constructionPhase || !currentEngine) return;
        try {
          const metrics = currentEngine.evaluateMetrics();
          if(backgroundHeartbeatInitialMetric === null){
            backgroundHeartbeatInitialMetric = Number(metrics?.soBuoiDay1) || 0;
          }
          self.postMessage({
            type: 'progress',
            mode: heartbeatMode,
            percent: 35,
            currentMetric: metrics?.soBuoiDay1,
            initialMetric: backgroundHeartbeatInitialMetric,
            stage: currentEngine.__activeStage || 'singleton_priority',
            metrics,
            targetMetricLowerBound: Number(currentEngine.constraintPreflight?.structuralFloor?.metricLowerBounds?.soBuoiDay1 || 0),
            heartbeat: true,
            elapsedMs: Date.now() - backgroundHeartbeatStartedAt,
            checkpoint: null,
            tkb: null
          });
        } catch (_) {}
      }, 500);
    };
    if (taskType === 'optimize') {
      const initialMetrics = currentEngine.evaluateMetrics();
      startBackgroundHeartbeat(mode);
      const res = await currentEngine.optimize(mode, (prog) => {
        currentEngine.__activeStage = prog?.stage || mode;
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
          if (normalized && !normalized.heartbeat &&
              (!bestCheckpoint || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || normalized.percent >= 100)) {
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
          heartbeat: normalized.heartbeat,
          sessionStates: normalized.sessionStates,
          periodStates: normalized.periodStates,
          stateBudget: normalized.stateBudget,
          elapsedMs: normalized.elapsedMs,
          checkpoint: normalized.heartbeat ? null : bestCheckpoint,
          tkb: normalized.heartbeat ? null : snapshotTkb
        });
      });
      stopBackgroundHeartbeat();

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
        startBackgroundHeartbeat(mode);
        res = await runSolveOptimizeAll((prog) => {
          if(currentEngine) currentEngine.__activeStage = prog?.stage || currentEngine.__activeStage || 'singleton_priority';
          let snapshotTkb = null;
          if (!constructionPhase) {
            const now = Date.now();
            if (prog && !prog.heartbeat &&
                (!bestCheckpoint || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || prog.percent >= 100)) {
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
            targetMetricLowerBound: prog?.targetMetricLowerBound,
            heartbeat: Boolean(prog?.heartbeat),
            sessionStates: prog?.sessionStates,
            periodStates: prog?.periodStates,
            stateBudget: prog?.stateBudget,
            elapsedMs: prog?.elapsedMs,
            checkpoint: prog?.heartbeat ? null : bestCheckpoint,
            tkb: prog?.heartbeat ? null : snapshotTkb
          });
        });
        stopBackgroundHeartbeat();
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
    }
  } catch (err) {
    cleanupBackgroundHeartbeat();
    self.postMessage({
      type: 'error',
      error: err?.message || String(err)
    });
  }
};
