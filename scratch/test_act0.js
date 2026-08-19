const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0 });
eng.init();
eng.loadExistingSchedule();

console.log('Total activities:', eng.activities.length);
console.log('Activity 0:', eng.activities[0]);
console.log('actPlacement[0]:', eng.actPlacement[0]);
console.log('verifyPlacementIntegrity:', eng.verifyPlacementIntegrity());
