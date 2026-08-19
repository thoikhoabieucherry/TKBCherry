const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('Initial metrics:', JSON.stringify(eng.evaluateMetrics()));

// Monkey patch captureStateSnapshot to log when it's called
const origCapture = eng.captureStateSnapshot;
let captureCount = 0;
eng.captureStateSnapshot = function() {
  const res = origCapture.apply(this, arguments);
  const m = this.evaluateMetrics();
  console.log(`[CAPTURE #${++captureCount}] singletons = ${m.soBuoiDay1}, gaps2 = ${m.soBuoiTrong2}`);
  return res;
};

eng.optimize('optimize_singletons').then(res => {
  console.log('Final result metrics:', JSON.stringify(res.metrics));
});
