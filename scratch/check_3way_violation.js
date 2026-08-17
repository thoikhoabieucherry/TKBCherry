const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

// Check if any 3-way swap has mismatch
for (let s1 = 0; s1 < 60; s1++) {
  for (let s2 = 0; s2 < 60; s2++) {
    if (s1 === s2) continue;
    for (let s3 = 0; s3 < 60; s3++) {
      if (s3 === s1 || s3 === s2) continue;

      const cGrid = opt.classGrid.get('L001');
      const a1 = cGrid[s1] >= 0 ? opt.activities[cGrid[s1]] : null;
      const a2 = cGrid[s2] >= 0 ? opt.activities[cGrid[s2]] : null;
      const a3 = cGrid[s3] >= 0 ? opt.activities[cGrid[s3]] : null;

      if (a1 && a2 && a3 && a1.duration === 1 && a2.duration === 1 && a3.duration === 1) {
        opt.unplaceActivity(a1.id);
        opt.unplaceActivity(a2.id);
        opt.unplaceActivity(a3.id);

        opt.placeActivityDirect(a1.id, s2);
        opt.placeActivityDirect(a2.id, s3);
        opt.placeActivityDirect(a3.id, s1);

        const v = opt.evaluateLessonBlockViolations();
        const safe = opt.isLessonBlockSafe(a1, a2, a3);

        if (v > 0 && safe) {
          console.log("3-WAY MISMATCH! evaluateLessonBlockViolations =", v, "but isLessonBlockSafe =", safe);
          process.exit(0);
        }

        opt.unplaceActivity(a1.id);
        opt.unplaceActivity(a2.id);
        opt.unplaceActivity(a3.id);

        opt.placeActivityDirect(a1.id, s1);
        opt.placeActivityDirect(a2.id, s2);
        opt.placeActivityDirect(a3.id, s3);
      }
    }
  }
}
console.log("All 3-way swaps verified safe!");
