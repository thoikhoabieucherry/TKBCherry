const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));

console.log('=== INSPECTING LIVE SID=DEFAULT ===');
console.log('Classes:', data.lop?.length, 'Teachers:', data.gv?.length);

const eng = new Engine(data, { mode: 'all', uiBreathingMs: 0 });
eng.init();
console.log('Activities count:', eng.activities.length);

eng.loadExistingSchedule();
const initialMetrics = eng.evaluateMetrics();
console.log('Initial metrics after loadExistingSchedule:', JSON.stringify(initialMetrics));

const rep = eng.repairHardConflicts();
console.log('Repair hard conflicts result:', JSON.stringify(rep));
console.log('Metrics after repair:', JSON.stringify(eng.evaluateMetrics()));

console.log('\n--- Running optimize_singletons ---');
let t0 = Date.now();
eng.optimize('optimize_singletons').then(res => {
  console.log(`optimize_singletons completed in ${Date.now() - t0}ms. Metrics:`, JSON.stringify(res.metrics));
  console.log('Integrity valid?', eng.verifyPlacementIntegrity());

  console.log('\n--- Running optimize_gap2 ---');
  t0 = Date.now();
  return eng.optimize('optimize_gap2');
}).then(res => {
  console.log(`optimize_gap2 completed in ${Date.now() - t0}ms. Metrics:`, JSON.stringify(res.metrics));
  console.log('Integrity valid?', eng.verifyPlacementIntegrity());

  console.log('\n--- Running optimizeAll ---');
  t0 = Date.now();
  const engAll = new Engine(data, { mode: 'all', uiBreathingMs: 0 });
  engAll.init();
  return engAll.optimizeAll((p) => {
    if (p.stage) {
      console.log(`  [${p.stage}] Stage ${p.stageIndex + 1}/${p.totalStages} - ${p.percent}% - Metric: ${p.currentMetric}`);
    }
  });
}).then(res => {
  console.log(`optimizeAll completed in ${Date.now() - t0}ms. Metrics:`, JSON.stringify(res.metrics));
}).catch(err => {
  console.error('ERROR during optimization:', err);
});
