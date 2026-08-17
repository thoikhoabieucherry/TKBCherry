/**
 * TKB FET Background Worker
 * Runs FetTimetableEngine on a dedicated background CPU thread
 * Guarantees 60 FPS smooth UI and instant cancellation
 */

// Import the FET engine into worker scope with cache buster
importScripts('tkb-fet-engine.js?v=' + Date.now());

let currentEngine = null;

self.onmessage = async function(e) {
  const action = e.data?.action || e.data?.type;
  const { mode, data, options } = e.data || {};

  if (action === 'optimize') {
    try {
      // Worker thread has no UI to protect: drop the per-round breathing delay.
      const workerOptions = Object.assign({ uiBreathingMs: 0 }, options || {});
      currentEngine = new self.FetTimetableEngine(data, workerOptions);

      const runOptimize = (cb) => {
        if (mode === 'optimize_all' && typeof currentEngine.optimizeAll === 'function') return currentEngine.optimizeAll(cb);
        // Nút "2 tiết trống": dùng cơ chế vay-trả 1t/buổi (không bao giờ tệ hơn chạy thường)
        if (mode === 'optimize_gap2' && typeof currentEngine.optimizeGap2WithBorrow === 'function') return currentEngine.optimizeGap2WithBorrow(cb);
        return currentEngine.optimize(mode, cb);
      };
      const res = await runOptimize((prog) => {
        let snapshotTkb = null;
        try { snapshotTkb = currentEngine.getSnapshotTKB(); } catch(_) {}
        self.postMessage({
          type: 'progress',
          mode: mode,
          percent: prog.percent,
          currentMetric: prog.currentMetric,
          initialMetric: prog.initialMetric,
          stage: prog.stage || null,
          cycle: prog.cycle,
          metrics: prog.metrics,
          checkpoint: {
            complete: true,
            tkb: snapshotTkb,
            metrics: prog.metrics
          },
          tkb: snapshotTkb
        });
      });

      self.postMessage({
        type: 'done',
        ok: true,
        applied: true,
        tkb: currentEngine.getSnapshotTKB(),
        initialMetrics: res.initialMetrics,
        metrics: res.metrics,
        placed: res.placed,
        unassigned: res.unassigned
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: err?.message || String(err)
      });
    }
  } else if (action === 'solve') {
    try {
      // FAIL-CLOSED: an optimize_* mode arriving on the construction lane means
      // a stale caller; refuse instead of rebuilding (and destroying) the grid.
      if (/^optimize/i.test(String(mode || ''))) {
        self.postMessage({ type: 'error', error: 'optimize mode routed to solve lane (stale client); refusing to rebuild' });
        return;
      }
      currentEngine = new self.FetTimetableEngine(data, options);
      const res = currentEngine.solve((prog) => {
        self.postMessage({
          type: 'progress',
          percent: prog.percent,
          placed: prog.placed,
          total: prog.total
        });
      });

      const snapshotTkb = currentEngine.getSnapshotTKB();
      self.postMessage({
        type: 'done',
        ok: true,
        applied: true,
        tkb: snapshotTkb,
        checkpoint: {
          complete: true,
          tkb: snapshotTkb
        },
        placed: res.placed,
        unassigned: res.unassigned,
        total: res.total || (res.placed + res.unassigned)
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: err?.message || String(err)
      });
    }
  }
};
