const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_fet_pair_first.js', 'utf8');
eval(engineCode.split('const artifactPath')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.init();
engine.computeDifficultiesAndSort();
engine.limitCalls = 100000;

console.log("Total activities:", engine.activities.length);
const dur2Acts = engine.activities.filter(a => a.duration === 2);
console.log("Duration 2 count:", dur2Acts.length);

let placedCount = 0;
dur2Acts.forEach((act, idx) => {
  engine.nCalls = 0;
  const ok = engine.randomSwap(act.id, 0);
  if(ok) placedCount++;
});

console.log(`Placed ${placedCount}/${dur2Acts.length} duration 2 activities!`);
