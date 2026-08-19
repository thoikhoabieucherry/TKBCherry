/**
 * TKB FET Background Worker
 * Runs FetTimetableEngine on a dedicated background CPU thread
 * Guarantees 60 FPS smooth UI and instant cancellation
 */

// Import the FET engine into worker scope with cache buster
importScripts('tkb-fet-engine.js?v=' + Date.now());

let currentEngine = null;


async function runSolveOptimizeAllImpl(cb, data, workerOptions, setEngine, isConstruction) {
  // XEP MOI + TOI UU TRON GOI trong MOT worker — CAM KET DU 100% TIET:
  // construction thu nhieu seed den khi DAT DU TIET (toi da 8 seed / ~75s);
  // chi khi du 100% moi chay optimizeAll (0 buoi 1 tiet, 0 trong >=2, giam
  // trong 1 + tong buoi). Khong bao gio ap lich thieu tiet — neu moi seed deu
  // thieu, tra fail-closed kem danh sach hoat dong ket de nguoi dung go rang
  // buoc; lich hien tai duoc giu nguyen.
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
  // CHI DAO 17/08: khong du cho thi van LAP TOI DA, phan du tra ve "Chua phan"
  // — khong fail-closed nua. So tiet con thieu duoc tra ve trung thuc qua
  // `unassigned` de UI canh bao ro rang.
  const opt = await bestEngine.optimizeAll((p) => {
    cb(Object.assign({}, p, { percent: 35 + Math.round(Math.min(100, Number(p.percent) || 0) * 0.65) }));
  });
  const out = opt || {};
  out.placed = Number(bestRes.placed) || 0;
  out.unassigned = Number(bestUnassigned) || 0;
  return out;
}

self.onmessage = async function(e) {
  const action = e.data?.action || e.data?.type;
  const { mode, data, options } = e.data || {};

  if (action === 'optimize') {
    try {
      // Worker thread has no UI to protect: drop the per-round breathing delay.
      const workerOptions = Object.assign({ uiBreathingMs: 0 }, options || {});
      currentEngine = new self.FetTimetableEngine(data, workerOptions);

      let constructionPhase = false; // solve_optimize_all: khong phat checkpoint khi luoi con dang xay (chua du tiet)
      const runSolveOptimizeAll = (cb) => runSolveOptimizeAllImpl(
        cb,
        data,
        workerOptions,
        (eng) => { if (eng) currentEngine = eng; },
        (v) => { constructionPhase = !!v; }
      );
      const runOptimize = async (cb) => {
        if (mode === 'solve_optimize_all' || mode === 'solve_optimize_all_fresh') {
          return await runSolveOptimizeAll(cb);
        }
        if (mode === 'optimize_all' && typeof currentEngine.optimizeAll === 'function') return currentEngine.optimizeAll(cb);
        // Nút "2 tiết trống": dùng cơ chế vay-trả 1t/buổi (không bao giờ tệ hơn chạy thường)
        if (mode === 'optimize_gap2' && typeof currentEngine.optimizeGap2WithBorrow === 'function') return currentEngine.optimizeGap2WithBorrow(cb);
        return currentEngine.optimize(mode, cb);
      };
      let lastSnapshotAt = 0;
      let lastSnapshotTkb = null;
      const SNAPSHOT_INTERVAL_MS = 250;

      const res = await runOptimize((prog) => {
        let snapshotTkb = null;
        if (!constructionPhase) {
          const now = Date.now();
          if (!lastSnapshotTkb || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS || prog.percent >= 100) {
            try { 
              lastSnapshotTkb = currentEngine.getSnapshotTKB(); 
              lastSnapshotAt = now;
            } catch(_) {}
          }
          snapshotTkb = lastSnapshotTkb;
        }
        self.postMessage({
          type: 'progress',
          mode: mode,
          percent: prog.percent,
          currentMetric: prog.currentMetric,
          initialMetric: prog.initialMetric,
          stage: prog.stage || null,
          cycle: prog.cycle,
          metrics: prog.metrics,
          checkpoint: snapshotTkb ? {
            complete: true,
            tkb: snapshotTkb,
            metrics: prog.metrics
          } : null,
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
      const res = await currentEngine.solve((prog) => {
        self.postMessage({
          type: 'progress',
          percent: prog.percent,
          placed: prog.placed,
          total: prog.total,
          message: prog.message || null
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
        total: res.total || (res.placed + res.unassigned),
        deadlineHit: res.deadlineHit === true,
        capacityDeficit: Number(res.capacityDeficit) || 0,
        capacityRows: Array.isArray(res.capacityRows) ? res.capacityRows : []
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: err?.message || String(err)
      });
    }
  }
};
