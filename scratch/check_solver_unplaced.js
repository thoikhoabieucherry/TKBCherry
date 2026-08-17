const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
const res = solver.solve();
console.log("Solver result placed:", res.placed, "unassigned:", res.unassigned);

// Revert solve to original state and check if any activity in solver.activities had duration or placement issue
solver.activities.forEach((act, idx) => {
  if (solver.actPlacement[idx] < 0) {
    console.log("Unplaced act in solver:", act);
  }
});
