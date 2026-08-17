const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

// Test swaps for each singleton
for(const [gv, grid] of opt.teacherGrid.entries()){
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      const taught = [];
      for(let p = 0; p < 5; p++){
        const s = sStart + p;
        if(grid[s] >= 0 || grid[s] === -3){
          taught.push({ p, slot: s, actId: grid[s] });
        }
      }
      if(taught.length === 1 && taught[0].actId >= 0){
        const act1 = opt.activities[taught[0].actId];
        const s1 = taught[0].slot;
        const cGrid = opt.classGrid.get(act1.classId);

        // Find candidate swaps in the class
        for(let s2 = 0; s2 < 60; s2++){
          if(s2 === s1 || opt.offSlots.has(`${act1.classId}|${s2}`)) continue;
          const actId2 = cGrid[s2];
          if(actId2 < 0) continue;
          const act2 = opt.activities[actId2];
          if(!act2 || act2.isFixed || act2.duration !== 1) continue;

          // Check if moving act1 -> s2 and act2 -> s1 works for teachers
          opt.unplaceActivity(act1.id);
          opt.unplaceActivity(act2.id);

          const r1 = opt.getConflictsForSlot(act1, s2);
          const r2 = opt.getConflictsForSlot(act2, s1);

          if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
            opt.placeActivityDirect(act1.id, s2);
            opt.placeActivityDirect(act2.id, s1);

            const isSafe = opt.isLessonBlockSafe(act1, act2);
            const m = opt.evaluateMetrics();

            console.log(`[SWAP TEST] Teacher ${gv} (act: ${act1.mon}): s1=${s1} <-> s2=${s2} (${act2.mon}, ${act2.gv}) | isSafe=${isSafe} | newSingletons=${m.soBuoiDay1}`);

            opt.unplaceActivity(act1.id);
            opt.unplaceActivity(act2.id);
          }
          opt.placeActivityDirect(act1.id, s1);
          opt.placeActivityDirect(act2.id, s2);
        }
      }
    }
  }
}
