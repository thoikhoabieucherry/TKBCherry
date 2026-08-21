"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { FetTimetableEngine } = require("../web/pages/tkb-fet-engine.js");

const input = JSON.parse(fs.readFileSync(path.resolve(__dirname, "live_default.json"), "utf8"));
const enginePath = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
const workerCode = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { FetTimetableEngine } = require(workerData.enginePath);
  (async () => {
    const engine = new FetTimetableEngine(workerData.data, {
      seed: workerData.seed,
      deepLocalFet: true,
      deepCycles: 12,
      sessionBinChains: true,
      reformLessonBlocks: true,
      allowSingletonGap2Tradeoff: true,
      uiBreathingMs: 0,
      sessionFirstStateBudget: 1000000
    });
    engine.loadExistingSchedule();
    engine.compileConstraints();
    engine.deadlineAtMs = Date.now() + workerData.budgetMs;
    const before = engine.evaluateMetrics();
    const started = Date.now();
    await engine.runUntilZeroSingletons({
      timeBudgetMs: workerData.budgetMs,
      maxPasses: 15,
      stagnationThreshold: 3
    });
    parentPort.postMessage({
      seed: workerData.seed,
      elapsedMs: Date.now() - started,
      before,
      after: engine.evaluateMetrics(),
      holes: engine.countTotalStudentHoles()
    });
  })().catch(error => parentPort.postMessage({ error: error.message }));
`;

function runOne(seed, budgetMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerCode, { eval: true, workerData: {
      enginePath,
      data: JSON.parse(JSON.stringify(input)),
      seed,
      budgetMs
    }});
    worker.once("message", result => resolve(result));
    worker.once("error", reject);
  });
}

(async () => {
  const seeds = [28183, 132912, 237641, 342370];
  const budgetMs = 5000;
  const serialStarted = Date.now();
  const serial = [];
  for (const seed of seeds) serial.push(await runOne(seed, budgetMs));
  const serialElapsedMs = Date.now() - serialStarted;
  const parallelStarted = Date.now();
  const parallel = await Promise.all(seeds.map(seed => runOne(seed, budgetMs)));
  const parallelElapsedMs = Date.now() - parallelStarted;
  console.log(JSON.stringify({ serialElapsedMs, parallelElapsedMs, serial, parallel }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
