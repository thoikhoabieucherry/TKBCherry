const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

const initM = eng.evaluateMetrics();
console.log('Initial metrics:', JSON.stringify(initM));

eng.optimize('optimize_singletons').then(res => {
  console.log('Returned metrics:', JSON.stringify(res.metrics));
  console.log('Engine evaluateMetrics:', JSON.stringify(eng.evaluateMetrics()));
});
