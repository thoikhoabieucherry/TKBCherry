const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
console.log('1. Right after init:', eng.evaluateMetrics().soBuoiDay1);

eng.loadExistingSchedule();
console.log('2. Right after loadExistingSchedule:', eng.evaluateMetrics().soBuoiDay1);

const rep = eng.repairHardConflicts();
console.log('3. Right after repairHardConflicts:', eng.evaluateMetrics().soBuoiDay1);
