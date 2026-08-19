#!/usr/bin/env node
"use strict";
/**
 * Cloud Run runner cho thuat toan "TRON GOI" (xep moi 100% tiet + toi uu
 * 0 buoi 1 tiet / 0 trong >=2 / giam trong 1 + tong buoi) — chay DUNG engine
 * FET cua trinh duyet (web/pages/tkb-fet-engine.js) trong Node VM.
 *
 * Giao thuc stdio y het solve_stdio.py de cloud_run_service.py dung chung:
 *   stdin  : JSON request {engine:"fet_trongoi", data:{...school...}, settings:{...}}
 *   stderr : cac dong "@@TKB_PROGRESS@@{json}"
 *   stdout : MOT dong JSON {"protocol":"tkb-reference-solver-stdio-v1","status":N,"payload":{...}}
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const STDIO_PROTOCOL = "tkb-reference-solver-stdio-v1";
const PROGRESS_PREFIX = "@@TKB_PROGRESS@@";
let progressSeq = 0;
const startedMs = Date.now();

function emitProgress(event) {
  try {
    progressSeq += 1;
    const payload = Object.assign({}, event, {
      protocol: "tkb-reference-solver-progress-v1",
      sequence: progressSeq,
      elapsedMs: Date.now() - startedMs,
      emittedAtMs: Date.now()
    });
    process.stderr.write(PROGRESS_PREFIX + JSON.stringify(payload) + "\n");
  } catch (_) {}
}

function writeResult(status, payload) {
  process.stdout.write(JSON.stringify({ protocol: STDIO_PROTOCOL, status, payload }) + "\n");
}

function loadEngine() {
  const configured = String(process.env.TKB_FET_ENGINE_PATH || "").trim();
  const enginePath = configured
    ? configured
    : path.resolve(__dirname, "..", "..", "web", "pages", "tkb-fet-engine.js");
  const source = fs.readFileSync(enginePath, "utf8");
  const window = {};
  const ctx = vm.createContext({
    window, globalThis: window, self: window, console,
    Date, Math, JSON, Map, Set, Array, String, Number, Object, RegExp, Promise,
    setTimeout, clearTimeout, Uint8Array
  });
  vm.runInContext(source, ctx, { filename: enginePath });
  if (typeof window.FetTimetableEngine !== "function") {
    throw new Error("tkb-fet-engine.js did not expose FetTimetableEngine");
  }
  return { Engine: window.FetTimetableEngine, window };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function watchStopFile(window) {
  const stopFile = String(process.env.TKB_SOLVER_STOP_FILE || "").trim();
  if (!stopFile) return null;
  const timer = setInterval(() => {
    try {
      if (fs.existsSync(stopFile)) {
        window.__AUTO_SORT_STOP_REQUESTED = true;
      }
    } catch (_) {}
  }, 2000);
  timer.unref?.();
  return timer;
}

(async () => {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch (error) {
    writeResult(400, { ok: false, error: "invalid_json", detail: String(error && error.message || error) });
    return;
  }
  const data = request && typeof request === "object" ? request.data : null;
  if (!data || typeof data !== "object" || !Array.isArray(data.lop)) {
    writeResult(400, { ok: false, error: "solver_request_invalid", detail: "data.lop missing" });
    return;
  }
  const settings = (request.settings && typeof request.settings === "object") ? request.settings : {};
  const seedBase = Number(settings.seed) || Number(request.seed) || 12345;
  const constructionBudgetMs = Math.max(5000, Math.min(120000, Number(settings.construction_budget_ms) || 75000));
  const optimizeBudgetMs = Math.max(20000, Math.min(240000, Number(settings.optimize_budget_ms) || 150000));
  const timeBudgetMs = Math.max(5000, Math.min(60000, Number(settings.construction_attempt_budget_ms) || 20000));

  let Engine, window;
  try {
    ({ Engine, window } = loadEngine());
  } catch (error) {
    writeResult(500, { ok: false, error: "engine_load_failed", detail: String(error && error.message || error) });
    return;
  }
  const stopTimer = watchStopFile(window);

  emitProgress({ stage: "start", message: "Bat dau xep + toi uu tron goi (FET engine)" });

  // ================= CONSTRUCTION: nhieu seed den khi DU 100% =================
  const MAX_ATTEMPTS = 8;
  const constructionDeadline = Date.now() + constructionBudgetMs;
  let bestEngine = null;
  let bestRes = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (window.__AUTO_SORT_STOP_REQUESTED) break;
    const engineData = JSON.parse(JSON.stringify(data));
    const eng = new Engine(engineData, { seed: seedBase + attempt * 7919, timeBudgetMs, uiBreathingMs: 0, optimizeAllBudgetMs: optimizeBudgetMs });
    let res;
    try {
      res = await eng.solve((p) => {
        emitProgress({ stage: "construction", attempt: attempt + 1, percent: Math.round(Math.min(100, Number(p.percent) || 0) * 0.35), placed: p.placed, total: p.total });
      });
    } catch (error) {
      res = { ok: false, error: String(error && error.message || error) };
    }
    try { eng.getSnapshotTKB(); } catch (_) {}
    const un = (res && res.ok !== false) ? (Number(res.unassigned) || 0) : Number.MAX_SAFE_INTEGER;
    const bestUn = bestRes ? ((bestRes.ok !== false) ? (Number(bestRes.unassigned) || 0) : Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    if (!bestRes || un < bestUn) { bestEngine = eng; bestRes = res; }
    if (un === 0) break;
    if (Date.now() > constructionDeadline) break;
  }

  const bestUnassigned = (bestRes && bestRes.ok !== false) ? (Number(bestRes.unassigned) || 0) : Number.MAX_SAFE_INTEGER;
  if (!bestRes || bestRes.ok === false || bestUnassigned > 0) {
    const blocked = [];
    try {
      if (bestEngine && Array.isArray(bestEngine.activities)) {
        bestEngine.activities.forEach((act, i) => {
          if (bestEngine.actPlacement[i] < 0 && blocked.length < 8) {
            blocked.push({ subject: `${act.classId || "?"} - ${act.mon || "?"}${act.gv ? " - " + act.gv : ""}`, allowedSlots: null });
          }
        });
      }
    } catch (_) {}
    if (stopTimer) clearInterval(stopTimer);
    writeResult(422, {
      ok: false,
      engine: "fet_trongoi",
      error: "fet_construction_incomplete",
      placed: (bestRes && Number(bestRes.placed)) || 0,
      unassigned: Number.isFinite(bestUnassigned) ? bestUnassigned : 0,
      diagnostics: { blockedActivities: blocked },
      metrics: null
    });
    return;
  }

  const initialMetrics = bestEngine.evaluateMetrics();
  emitProgress({ stage: "optimize", percent: 35, message: "Da xep du 100% tiet — bat dau toi uu tron goi", metrics: initialMetrics });

  // ================= OPTIMIZE ALL (0 / 0 / giam trong1 + buoi) ================
  let opt = null;
  try {
    opt = await bestEngine.optimizeAll((p) => {
      emitProgress({ stage: "optimize", percent: 35 + Math.round(Math.min(100, Number(p.percent) || 0) * 0.65), metrics: p.metrics || null, stageDetail: p.stage || null });
    });
  } catch (error) {
    emitProgress({ stage: "optimize", message: "optimizeAll error: " + String(error && error.message || error) });
  }
  if (stopTimer) clearInterval(stopTimer);

  const finalMetrics = bestEngine.evaluateMetrics();
  const tkb = bestEngine.getSnapshotTKB();
  // Dem o tiet de tu-kiem: khong bao gio tra lich thieu so voi construction.
  let cellCount = 0;
  try {
    for (const cid of Object.keys(tkb || {})) {
      const byDay = tkb[cid];
      for (const thu of Object.keys(byDay || {})) {
        const byBuoi = byDay[thu];
        for (const buoi of Object.keys(byBuoi || {})) {
          for (const cell of (byBuoi[buoi] || [])) { if (cell && cell !== "OFF") cellCount++; }
        }
      }
    }
  } catch (_) {}

  writeResult(200, {
    ok: true,
    engine: "fet_trongoi",
    applied: true,
    tkb,
    placed: Number(bestRes.placed) || 0,
    unassigned: 0,
    cellCount,
    initialMetrics,
    metrics: finalMetrics,
    stopped: window.__AUTO_SORT_STOP_REQUESTED === true,
    runtimeMs: Date.now() - startedMs
  });
})().catch((error) => {
  writeResult(500, { ok: false, error: "fet_trongoi_runner_failed", detail: String(error && error.stack || error) });
});
