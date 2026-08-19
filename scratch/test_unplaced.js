const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0 });

eng.loadExistingSchedule();
console.log('0. Before start: integrity =', eng.verifyPlacementIntegrity());

eng.optimizeAll((p) => {
  // console.log(`[Stage progress] ${p.stage}: ${p.percent}%`);
}).then(res => {
  console.log('Final integrity:', eng.verifyPlacementIntegrity());
  console.log('Unplaced count:', eng.actPlacement.filter(p => p < 0).length);
  for(let id = 0; id < eng.activities.length; id++){
    if(eng.actPlacement[id] < 0){
      console.log(`Unplaced act id=${id}:`, eng.activities[id]);
      break;
    }
  }
});
