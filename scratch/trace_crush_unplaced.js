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

const initialMetrics = opt.evaluateMetrics();
let bestMetrics = { ...initialMetrics };

for(let round = 0; round < 50; round++){
  const beforeUnplaced = opt.activities.filter(a => opt.actPlacement[a.id] < 0).length;
  const res = opt.tryCrushTeacherGaps(bestMetrics, initialMetrics, "optimize_gap2");
  const afterUnplaced = opt.activities.filter(a => opt.actPlacement[a.id] < 0).length;
  if(afterUnplaced > beforeUnplaced){
    console.error(`Round ${round} created unplaced! Before: ${beforeUnplaced}, After: ${afterUnplaced}`);
    console.error("Return val was:", res);
    break;
  }
  if(res){
    bestMetrics = { ...res };
  }else{
    break;
  }
}
