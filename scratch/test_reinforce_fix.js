const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Replace if(existingActId < 0){ ... } with if(existingActId < 0) continue; in tryReinforceTeacherSingletons
engineCode = engineCode.replace(/if\(existingActId < 0\)[\s\S]*?this\.placeActivityDirect\(actToPull\.id, item\.slot\);\s*\}/, 'if(existingActId < 0) continue;');

// Also in tryConsolidateTeacherSingletons:
engineCode = engineCode.replace(/if\(actIdDst < 0\)[\s\S]*?this\.placeActivityDirect\(itemA\.act\.id, itemA\.slot\);\s*\}/, 'if(actIdDst < 0) continue;');

// Also in obliterateAllTeacherSingletons:
engineCode = engineCode.replace(/if\(actId2 < 0\)[\s\S]*?this\.placeActivityDirect\(act1\.id, s1\);\s*\}/, 'if(actId2 < 0) continue;');

eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();
console.log('Initial metrics:', opt.evaluateMetrics());

opt.optimize('optimize_singletons').then(res => {
  console.log('Optimized singletons:', res.metrics);
  console.log('Violations:', opt.evaluateLessonBlockViolations());
  console.log('Placed:', res.placed, 'Unassigned:', res.unassigned);
});
