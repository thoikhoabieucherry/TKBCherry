const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

async function runBenchmark(fileLabel, filePath) {
  console.log(`\n==================================================`);
  console.log(`BENCHMARK: ${fileLabel}`);
  console.log(`File: ${filePath}`);
  console.log(`==================================================`);
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const eng = new Engine(data, { mode: 'all', uiBreathingMs: 0 });
  const t0 = Date.now();
  eng.init();
  const initMs = Date.now() - t0;
  console.log(`Init time: ${initMs}ms`);
  console.log(`Initial metrics:`, JSON.stringify(eng.evaluateMetrics()));

  let lastStage = '';
  let stageStart = Date.now();
  const tStart = Date.now();
  let progressCount = 0;

  await eng.optimizeAll((progress) => {
    progressCount++;
    if (progress.stage !== lastStage) {
      if (lastStage) {
        console.log(`  -> Stage [${lastStage}] took ${Date.now() - stageStart}ms`);
      }
      lastStage = progress.stage;
      stageStart = Date.now();
      console.log(`[${(Date.now() - tStart)/1000}s] Stage ${progress.stageIndex + 1}/${progress.totalStages}: ${progress.stage} (metric: ${progress.currentMetric})`);
    }
  });
  if (lastStage) {
    console.log(`  -> Stage [${lastStage}] took ${Date.now() - stageStart}ms`);
  }

  const totalMs = Date.now() - tStart;
  console.log(`\n--------------------------------------------------`);
  console.log(`TOTAL TIME: ${totalMs}ms (${(totalMs / 1000).toFixed(2)}s), Updates: ${progressCount}`);
  console.log(`Final metrics:`, JSON.stringify(eng.evaluateMetrics()));
  console.log(`--------------------------------------------------\n`);
}

async function main() {
  await runBenchmark('DEFAULT SCHOOL', 'c:/Users/Love/Documents/Codex/TKBCherry/scratch/default_school_0317.json');
  await runBenchmark('SCHOOL 95671c41791', 'c:/Users/Love/Documents/Codex/TKBCherry/scratch/school_95671c41791.json');
}

main().catch(err => console.error(err));
