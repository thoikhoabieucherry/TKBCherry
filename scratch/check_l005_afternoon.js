const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

const l005Grid = opt.classGrid.get("L005");
console.log("Class L005 on Day 4 (d=2), Day 5 (d=3), Day 7 (d=5) Chiều:");
[2, 3, 5].forEach(d => {
  console.log(`Day ${d+2} Chiều:`);
  for(let p = 0; p < 5; p++){
    const s = d * 10 + 5 + p;
    const actId = l005Grid[s];
    const act = actId >= 0 ? opt.activities[actId] : null;
    console.log(`  P${p+1} (slot ${s}): ${act ? `${act.mon} (${act.gv}, dur=${act.duration}, actId=${act.id})` : 'EMPTY'}`);
  }
});
