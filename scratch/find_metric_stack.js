const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

eng.optimize('optimize_singletons', (p) => {
  if (p.currentMetric > 30) {
    console.log('--- FOUND HIGH METRIC ---', p.currentMetric);
    console.log(new Error().stack);
    process.exit(0);
  }
});
