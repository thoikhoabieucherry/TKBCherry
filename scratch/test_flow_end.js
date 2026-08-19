const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('1. Initial:', JSON.stringify(eng.evaluateMetrics()));

// Let's run a single round manually or optimize
eng.optimize('optimize_singletons').then(res => {
  console.log('2. After optimize res.metrics:', JSON.stringify(res.metrics));
  console.log('3. After optimize evaluateMetrics:', JSON.stringify(eng.evaluateMetrics()));
});
