const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { mode: 'optimize_singletons', uiBreathingMs: 0 });
eng.init();
console.log('Metrics before loadExistingSchedule:', JSON.stringify(eng.evaluateMetrics()));

eng.loadExistingSchedule();
console.log('Metrics after loadExistingSchedule:', JSON.stringify(eng.evaluateMetrics()));

console.log('Teacher singletons:');
for (const [tKey, tGrid] of eng.teacherGrid.entries()) {
  if (!tKey || !eng.isScoredTeacher(tKey)) continue;
  let count = 0;
  for (let d = 0; d < 6; d++) {
    for (let b = 0; b < 2; b++) {
      let taught = 0;
      for (let p = 0; p < 5; p++) {
        if (tGrid[d * 10 + b * 5 + p] >= 0 || tGrid[d * 10 + b * 5 + p] === -3) taught++;
      }
      if (taught === 1) count++;
    }
  }
  if (count > 0) {
    console.log(`  Teacher ${tKey}: ${count} singletons`);
  }
}
