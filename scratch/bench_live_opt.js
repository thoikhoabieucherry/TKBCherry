const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('=== BENCHMARK OPTIMIZE_SINGLETONS ON LIVE DEFAULT ===');
let t0 = Date.now();
let lastM = eng.evaluateMetrics().soBuoiDay1;
console.log('Start singletons:', lastM);

eng.optimize('optimize_singletons', (p) => {
  if (p.currentMetric !== lastM) {
    console.log(`[${Date.now() - t0}ms] Singletons improved: ${lastM} -> ${p.currentMetric} (Progress: ${p.percent}%)`);
    lastM = p.currentMetric;
  }
}).then(res => {
  console.log(`Completed in ${Date.now() - t0}ms! Final singletons: ${res.metrics.soBuoiDay1}, gaps2: ${res.metrics.soBuoiTrong2}`);
  console.log('Integrity valid?', eng.verifyPlacementIntegrity());
}).catch(console.error);
