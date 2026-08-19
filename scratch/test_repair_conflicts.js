const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('1. Right after loadExistingSchedule:');
console.log('Metrics:', JSON.stringify(eng.evaluateMetrics()));
console.log('Integrity:', eng.verifyPlacementIntegrity());

const rep = eng.repairHardConflicts();
console.log('2. Right after repairHardConflicts:', JSON.stringify(rep));
console.log('Metrics:', JSON.stringify(eng.evaluateMetrics()));
console.log('Integrity:', eng.verifyPlacementIntegrity());
