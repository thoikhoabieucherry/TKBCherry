const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

console.log("Initial violations:", opt.evaluateLessonBlockViolations());
console.log("classSubjectLessonBlocks size:", opt.classSubjectLessonBlocks?.size);

// Try 1 single swap and test isLessonBlockSafe
let safeCount = 0;
let unsafeCount = 0;

for (let s1 = 0; s1 < 60; s1++) {
  for (let s2 = s1 + 1; s2 < 60; s2++) {
    const cGrid = opt.classGrid.get('L001');
    const a1 = cGrid[s1] >= 0 ? opt.activities[cGrid[s1]] : null;
    const a2 = cGrid[s2] >= 0 ? opt.activities[cGrid[s2]] : null;
    if (a1 && a2 && a1.duration === 1 && a2.duration === 1) {
      opt.unplaceActivity(a1.id);
      opt.unplaceActivity(a2.id);
      opt.placeActivityDirect(a1.id, s2);
      opt.placeActivityDirect(a2.id, s1);
      
      const safe = opt.isLessonBlockSafe(a1, a2);
      if (safe) safeCount++;
      else unsafeCount++;
      
      opt.unplaceActivity(a1.id);
      opt.unplaceActivity(a2.id);
      opt.placeActivityDirect(a1.id, s1);
      opt.placeActivityDirect(a2.id, s2);
    }
  }
}

console.log("Safe swaps count:", safeCount, "Unsafe swaps count:", unsafeCount);
