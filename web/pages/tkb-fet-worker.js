/**
 * TKB FET Background Worker
 * Runs FetTimetableEngine on a dedicated background CPU thread
 * Guarantees 60 FPS smooth UI and instant cancellation
 */

// Import the FET engine into worker scope with cache buster
importScripts('tkb-fet-engine.js?v=' + Date.now());

let currentEngine = null;

async function runSolveOptimizeAllImpl(cb, data, workerOptions, setEngine, isConstruction) {
  const baseSeed = Number(workerOptions.seed) || 12345;
  const MAX_ATTEMPTS = 8;
  const ATTEMPT_DEADLINE_MS = Date.now() + 75000;
  let bestEngine = null;
  let bestRes = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    isConstruction(true);
    const engineData = JSON.parse(JSON.stringify(data));
    const eng = new self.FetTimetableEngine(engineData, Object.assign({}, workerOptions, { seed: baseSeed + attempt * 7919 }));
    setEngine(eng);
    const res = await eng.solve((p) => {
      cb({
        percent: Math.round(Math.min(100, Number(p.percent) || 0) * 0.35),
        currentMetric: p.placed,
        initialMetric: p.total,
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
  setEngine(bestEngine);
  const bestUnassigned = (bestRes && bestRes.ok !== false) ? (Number(bestRes.unassigned) || 0) : Number.MAX_SAFE_INTEGER;
  if (!bestRes || bestRes.ok === false) {
    return Object.assign({ initialMetrics: null, metrics: null }, bestRes || { ok: false, applied: false, failureKind: 'fet_construction_failed' });
  }

  const opt = await bestEngine.optimizeAll((p) => {
    cb(Object.assign({}, p, { percent: 35 + Math.round(Math.min(100, Number(p.percent) || 0) * 0.65) }));
  });
  const out = opt || {};
  out.placed = Number(bestRes.placed) || 0;
  out.unassigned = Number(bestUnassigned) || 0;
  return out;
}

self.onmessage = async function(e) {
  const taskType = e.data?.action || e.data?.type;
  const { mode, data, options } = e.data || {};

  try {
    const workerOptions = Object.assign({ uiBreathingMs: 0 }, options || {});
    currentEngine = new self.FetTimetableEngine(data, workerOptions);

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

    const isSolveOptMode = mode === 'solve_optimize_all' || mode === 'solve_optimize_all_fresh' || mode === 'auto' || taskType === 'solve';
    let res = null;

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
      res = await currentEngine.optimize(mode, (prog) => {
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
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: err?.message || String(err)
    });
  }
};
