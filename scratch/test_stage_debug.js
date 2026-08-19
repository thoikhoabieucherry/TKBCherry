const fs = require('fs');
global.self = global;
require('c:/Users/Love/Documents/Codex/TKBCherry/web/pages/tkb-fet-engine.js');
const Engine = global.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync('c:/Users/Love/Documents/Codex/TKBCherry/scratch/live_default.json', 'utf8'));
const eng = new Engine(data, { uiBreathingMs: 0 });

eng.loadExistingSchedule();
console.log('Start integrity:', eng.verifyPlacementIntegrity());

const origOpt = eng.optimize;
let optCall = 0;
eng.optimize = async function(mode, cb) {
  console.log(`\n>>> START STAGE #${++optCall}: mode=${mode}`);
  console.log(`    Before stage: integrity=${this.verifyPlacementIntegrity()}, metrics=${JSON.stringify(this.evaluateMetrics())}`);
  const res = await origOpt.apply(this, arguments);
  console.log(`    After stage:  integrity=${this.verifyPlacementIntegrity()}, res.metrics=${JSON.stringify(res.metrics)}`);
  return res;
};

eng.optimizeAll().then(res => {
  console.log('\n=== OPTIMIZE_ALL FINISHED ===');
  console.log('Final integrity:', eng.verifyPlacementIntegrity());
  console.log('Metrics:', JSON.stringify(res.metrics));
});
