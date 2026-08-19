const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/school_95671c41791.json', 'utf8'));
const eng = new Engine(data, { mode: 'all' });
console.log('Total activities created in constructor:', eng.activities.length);
eng.init();
console.log('After init:');
console.log('  Placed:', eng.actPlacement.filter(p => p >= 0).length, '/', eng.activities.length);
console.log('  Metrics:', eng.evaluateMetrics());

eng.loadExistingSchedule();
console.log('After loadExistingSchedule:');
console.log('  Placed:', eng.actPlacement.filter(p => p >= 0).length, '/', eng.activities.length);
console.log('  Metrics:', eng.evaluateMetrics());

const rep = eng.repairHardConflicts();
console.log('After repairHardConflicts:');
console.log('  Repaired:', rep);
console.log('  Placed:', eng.actPlacement.filter(p => p >= 0).length, '/', eng.activities.length);
console.log('  Metrics:', eng.evaluateMetrics());
