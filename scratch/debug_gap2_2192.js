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

console.log("Initial unplaced:", opt.activities.filter(a => opt.actPlacement[a.id] < 0).length);

opt.optimize("optimize_gap2").then(res => {
  console.log("Result:", res);
  const unplaced = opt.activities.filter(a => opt.actPlacement[a.id] < 0);
  console.log("Unplaced after gap2:", unplaced.length);
  if(unplaced.length > 0){
    console.log("Unplaced activity details:", unplaced);
  }
});
