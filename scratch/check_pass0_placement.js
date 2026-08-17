const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_fet_pair_first.js', 'utf8');
eval(engineCode.split('const artifactPath')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.init();
engine.computeDifficultiesAndSort();

console.log("Total activities:", engine.activities.length);
console.log("Duration 2 activities count:", engine.activities.filter(a => a.duration === 2).length);

// Try placing only duration === 2 activities
let dur2Placed = 0;
let dur2Failed = 0;
engine.activities.filter(a => a.duration === 2).forEach(act => {
  engine.nCalls = 0;
  const ok = engine.randomSwap(act.id, 0);
  if(ok) dur2Placed++;
  else dur2Failed++;
});

console.log(`Placed duration 2 activities: ${dur2Placed}/${dur2Placed + dur2Failed} (Failed: ${dur2Failed})`);
