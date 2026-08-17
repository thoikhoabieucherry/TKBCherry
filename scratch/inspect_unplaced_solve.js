const fs = require('fs');
const path = require('path');

let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

engine.solve();

const unplaced = engine.activities.filter(a => engine.actPlacement[a.id] < 0);
console.log("Unplaced activities count:", unplaced.length);
unplaced.forEach(a => {
  console.log(`Unplaced: id ${a.id}, class ${a.classId}, mon ${a.mon}, gv ${a.gv}, dur ${a.duration}`);
  // Check why it can't be placed anywhere
  let possibleCount = 0;
  for(let s = 0; s < 60; s++){
    const res = engine.getConflictsForSlot(a, s);
    if(res.possible) possibleCount++;
  }
  console.log(`  Possible slots for this act: ${possibleCount}`);
});
