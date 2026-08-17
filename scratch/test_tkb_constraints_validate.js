const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const constraintsCode = fs.readFileSync('web/pages/tkb-constraints.js', 'utf8');
const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

globalThis.window = globalThis;
eval(constraintsCode);
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const baselineReport = globalThis.TKBConstraints.validateAll(schoolData, schoolData.tkb);
console.log("Baseline violations count after solve:", baselineReport.violations?.length || 0);

// Test optimize_singletons
const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

opt.optimize('optimize_singletons').then(res => {
  const optReport = globalThis.TKBConstraints.validateAll(schoolData, schoolData.tkb);
  console.log("Opt singletons violations count:", optReport.violations?.length || 0);
  if (optReport.violations?.length > 0) {
    console.log("Sample violations:", optReport.violations.slice(0, 5));
  }
});
