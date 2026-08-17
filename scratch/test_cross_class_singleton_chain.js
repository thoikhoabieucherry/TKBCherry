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

// Step 1: Initial Crusher
opt.obliterateAllTeacherSingletons(20, Infinity);
opt.tryConsolidateTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);
opt.tryReinforceTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);

console.log("After initial crusher:", opt.evaluateMetrics());

// Step 2: Multi-Class 4-Way Ejection Chain
function solveSingletonsViaCrossClassChain(engine, maxPasses = 50){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let bestM = engine.evaluateMetrics();

  for(let pass = 0; pass < maxPasses; pass++){
    if(bestM.soBuoiDay1 <= 2) break;
    let passImproved = false;

    // Find all singleton instances
    const singletons = [];
    for(const [gv, grid] of engine.teacherGrid.entries()){
      for(let d = 0; d < DAYS; d++){
        for(let b = 0; b < SESSIONS; b++){
          const sStart = d * 10 + b * 5;
          const taught = [];
          for(let p = 0; p < PERIODS; p++){
            const s = sStart + p;
            if(grid[s] >= 0 || grid[s] === -3){
              taught.push({ p, slot: s, actId: grid[s] });
            }
          }
          if(taught.length === 1 && taught[0].actId >= 0){
            const act = engine.activities[taught[0].actId];
            if(act && !act.isFixed && act.duration === 1){
              singletons.push({ gv, day: d, session: b, slot: taught[0].slot, act });
            }
          }
        }
      }
    }

    engine.rng.shuffle(singletons);

    for(const sing of singletons){
      const act1 = sing.act;
      const s1 = sing.slot;
      const cGrid1 = engine.classGrid.get(act1.classId);
      if(!cGrid1) continue;

      let resolved = false;

      // Scan all s2 in class 1
      for(let s2 = 0; s2 < 60; s2++){
        if(s2 === s1 || engine.offSlots.has(`${act1.classId}|${s2}`)) continue;
        const actId2 = cGrid1[s2];
        if(actId2 < 0) continue;

        const act2 = engine.activities[actId2];
        if(!act2 || act2.isFixed || act2.duration !== 1) continue;

        // Ejection Step: act1 -> s2. Now act2 needs to find a slot.
        // Option 1: act2 -> s1 (Direct 2-way)
        const tGrid2 = engine.teacherGrid.get(act2.gv);
        if(tGrid2 && tGrid2[s1] < 0 && tGrid2[s1] !== -3){
          engine.unplaceActivity(act1.id);
          engine.unplaceActivity(act2.id);

          const r1 = engine.getConflictsForSlot(act1, s2);
          const r2 = engine.getConflictsForSlot(act2, s1);

          if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
            engine.placeActivityDirect(act1.id, s2);
            engine.placeActivityDirect(act2.id, s1);

            if(engine.isLessonBlockSafe(act1, act2)){
              const m = engine.evaluateMetrics();
              if(m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)){
                bestM = { ...m };
                passImproved = true;
                resolved = true;
                console.log(`[Cross-Class 2-Way] ${bestM.soBuoiDay1}`);
                break;
              }
            }
            engine.unplaceActivity(act1.id);
            engine.unplaceActivity(act2.id);
          }
          engine.placeActivityDirect(act1.id, s1);
          engine.placeActivityDirect(act2.id, s2);
        }
        if(resolved) break;

        // Option 2: Cross-Class 4-Way Chain:
        // In Class 1: act1 -> s2, actA (from sA in Class 1) -> s1.
        // In Class 2 (taught by act2.gv): act2 -> sB (in Class 2), actB (from sB in Class 2) -> sA (in Class 1, if actB.gv can teach at sA!)
        for(let sA = 0; sA < 60; sA++){
          if(sA === s1 || sA === s2 || engine.offSlots.has(`${act1.classId}|${sA}`)) continue;
          const actIdA = cGrid1[sA];
          if(actIdA < 0) continue;
          const actA = engine.activities[actIdA];
          if(!actA || actA.isFixed || actA.duration !== 1) continue;

          // Check if actA can go to s1
          const tGridA = engine.teacherGrid.get(actA.gv);
          if(!tGridA || tGridA[s1] >= 0 || tGridA[s1] === -3) continue;

          // Now slot sA in Class 1 is vacant for act2!
          // Can act2 go to sA?
          if(tGrid2 && tGrid2[sA] < 0 && tGrid2[sA] !== -3){
            engine.unplaceActivity(act1.id);
            engine.unplaceActivity(act2.id);
            engine.unplaceActivity(actA.id);

            const r1 = engine.getConflictsForSlot(act1, s2);
            const r2 = engine.getConflictsForSlot(act2, sA);
            const rA = engine.getConflictsForSlot(actA, s1);

            if(r1.possible && r1.conflicts.length === 0 &&
               r2.possible && r2.conflicts.length === 0 &&
               rA.possible && rA.conflicts.length === 0){
              engine.placeActivityDirect(act1.id, s2);
              engine.placeActivityDirect(act2.id, sA);
              engine.placeActivityDirect(actA.id, s1);

              if(engine.isLessonBlockSafe(act1, act2, actA)){
                const m = engine.evaluateMetrics();
                if(m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)){
                  bestM = { ...m };
                  passImproved = true;
                  resolved = true;
                  console.log(`[Intra-Class 3-Way Cycle] ${bestM.soBuoiDay1}`);
                  break;
                }
              }
              engine.unplaceActivity(act1.id);
              engine.unplaceActivity(act2.id);
              engine.unplaceActivity(actA.id);
            }
            engine.placeActivityDirect(act1.id, s1);
            engine.placeActivityDirect(act2.id, s2);
            engine.placeActivityDirect(actA.id, sA);
          }
          if(resolved) break;
        }
        if(resolved) break;
      }
      if(resolved) break;
    }

    if(!passImproved) break;
  }

  return bestM;
}

solveSingletonsViaCrossClassChain(opt, 50);
console.log("Final Metrics:", opt.evaluateMetrics());
