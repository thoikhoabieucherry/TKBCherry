const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_fet_pair_first.js', 'utf8');
eval(engineCode.split('const artifactPath')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.init();

const act0 = engine.activities.find(a => a.duration === 2);
console.log("Testing act0:", act0);

for(let s = 0; s < 60; s++){
  const res = engine.getConflictsForSlot(act0, s);
  console.log(`Slot ${s}: possible=${res.possible}, conflicts=${res.conflicts.length}`);
}
