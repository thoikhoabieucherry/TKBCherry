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

// Check if any swap causes evaluateLessonBlockViolations > 0
let origSwap = opt.placeActivityDirect.bind(opt);

// Let's step through obliterate manually for teacher 0
const teacherList = Array.from(opt.teacherGrid.keys()).filter(Boolean);
for (const tKey of teacherList) {
  const tGrid = opt.teacherGrid.get(tKey);
  if (!tGrid) continue;

  for (let d = 0; d < 6; d++) {
    for (let b = 0; b < 2; b++) {
      const sStart = d * 10 + b * 5;
      const taught = [];
      for (let p = 0; p < 5; p++) {
        const s = sStart + p;
        if (tGrid[s] >= 0) {
          const act = opt.activities[tGrid[s]];
          if (act && !act.isFixed && act.duration === 1) {
            taught.push({ slot: s, actId: tGrid[s], p });
          }
        }
      }
      if (taught.length !== 1) continue;

      const act1 = opt.activities[taught[0].actId];
      const s1 = taught[0].slot;
      const cGrid = opt.classGrid.get(act1.classId);

      for (let s2 = 0; s2 < 60; s2++) {
        if (s2 === s1) continue;
        const actId2 = cGrid[s2];
        if (actId2 >= 0) {
          const act2 = opt.activities[actId2];
          if (act2 && !act2.isFixed && act2.duration === 1) {
            opt.unplaceActivity(act1.id);
            opt.unplaceActivity(act2.id);
            opt.placeActivityDirect(act1.id, s2);
            opt.placeActivityDirect(act2.id, s1);

            const v = opt.evaluateLessonBlockViolations();
            const safe = opt.isLessonBlockSafe(act1, act2);

            if (v > 0 && safe) {
              console.log("MISMATCH! evaluateLessonBlockViolations =", v, "but isLessonBlockSafe =", safe);
              console.log("act1:", act1.mon, "cid:", act1.classId, "from", s1, "to", s2);
              console.log("act2:", act2.mon, "cid:", act2.classId, "from", s2, "to", s1);
              process.exit(0);
            }

            opt.unplaceActivity(act1.id);
            opt.unplaceActivity(act2.id);
            opt.placeActivityDirect(act1.id, s1);
            opt.placeActivityDirect(act2.id, s2);
          }
        }
      }
    }
  }
}
console.log("Finished check, no mismatch found!");
