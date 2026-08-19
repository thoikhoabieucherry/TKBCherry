const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));

const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
console.log('1. eng.evaluateMetrics() before optimize:', JSON.stringify(eng.evaluateMetrics()));

const origLoad = eng.loadExistingSchedule;
eng.loadExistingSchedule = function() {
  origLoad.apply(this, arguments);
  console.log('2. Inside loadExistingSchedule metrics:', JSON.stringify(this.evaluateMetrics()));
};

eng.optimize('optimize_singletons').then(res => {
  console.log('3. Finished optimize, final metrics:', JSON.stringify(res.metrics));
});
