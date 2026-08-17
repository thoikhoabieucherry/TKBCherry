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

// Check if isLessonBlockSafe returns true but evaluateLessonBlockViolations is non-zero
for (let i = 0; i < opt.activities.length; i++) {
  const a1 = opt.activities[i];
  if (!a1 || a1.isFixed || a1.duration !== 1) continue;
  const s1 = opt.actPlacement[a1.id];
  const cGrid = opt.classGrid.get(a1.classId);

  for (let s2 = 0; s2 < 60; s2++) {
    if (s2 === s1) continue;
    const a2Id = cGrid[s2];
    if (a2Id < 0) continue;
    const a2 = opt.activities[a2Id];
    if (!a2 || a2.isFixed || a2.duration !== 1) continue;

    opt.unplaceActivity(a1.id);
    opt.unplaceActivity(a2.id);
    opt.placeActivityDirect(a1.id, s2);
    opt.placeActivityDirect(a2.id, s1);

    const safe = opt.isLessonBlockSafe(a1, a2);
    const v = opt.evaluateLessonBlockViolations();

    if (safe && v > 0) {
      console.log("Found discrepancy on 2-way swap!");
      console.log("a1:", a1.mon, "cid:", a1.classId, "from", s1, "to", s2);
      console.log("a2:", a2.mon, "cid:", a2.classId, "from", s2, "to", s1);
      console.log("Violations:", v);
      process.exit(0);
    }

    opt.unplaceActivity(a1.id);
    opt.unplaceActivity(a2.id);
    opt.placeActivityDirect(a1.id, s1);
    opt.placeActivityDirect(a2.id, s2);
  }
}
console.log("No 2-way swap discrepancy found!");
