const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

console.log("Initial violations right after solve:", solver.evaluateLessonBlockViolations());

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();
console.log("Violations right after loadExistingSchedule:", opt.evaluateLessonBlockViolations());

opt.optimize('optimize_singletons').then(res => {
  console.log("Violations after optimize_singletons:", opt.evaluateLessonBlockViolations());
});
