const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

let _gbM = null;
Object.defineProperty(eng, '__globalBestM', {
  get() { return _gbM; },
  set(val) {
    console.log(`[__globalBestM SET]`, JSON.stringify(val), new Error().stack.split('\n')[2].trim());
    _gbM = val;
  }
});

eng.optimize('optimize_singletons').then(res => {
  console.log('Optimize returned:', JSON.stringify(res.metrics));
});
