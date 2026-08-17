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

// Step 2: Global BFS Augmenting Path for Singletons
function solveSingletonsViaBFS(engine, maxPasses = 50){
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

      // Strategy 1: Move act1 to ANY valid slot s2 in its class
      for(let s2 = 0; s2 < 60; s2++){
        if(s2 === s1 || engine.offSlots.has(`${act1.classId}|${s2}`)) continue;
        const actId2 = cGrid1[s2];

        // 1.1 Empty slot
        if(actId2 < 0){
          engine.unplaceActivity(act1.id);
          const r1 = engine.getConflictsForSlot(act1, s2);
          if(r1.possible && r1.conflicts.length === 0){
            engine.placeActivityDirect(act1.id, s2);
            if(engine.isLessonBlockSafe(act1)){
              const m = engine.evaluateMetrics();
              if(m.soBuoiDay1 < bestM.soBuoiDay1){
                bestM = { ...m };
                passImproved = true;
                resolved = true;
                console.log(`[BFS-1] Empty: ${bestM.soBuoiDay1}`);
                break;
              }
            }
            engine.unplaceActivity(act1.id);
          }
          engine.placeActivityDirect(act1.id, s1);
          continue;
        }

        // 1.2 Swap with act2
        const act2 = engine.activities[actId2];
        if(!act2 || act2.isFixed || act2.duration !== 1) continue;

        // Try direct swap
        engine.unplaceActivity(act1.id);
        engine.unplaceActivity(act2.id);

        const r1 = engine.getConflictsForSlot(act1, s2);
        const r2 = engine.getConflictsForSlot(act2, s1);

        if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
          engine.placeActivityDirect(act1.id, s2);
          engine.placeActivityDirect(act2.id, s1);

          if(engine.isLessonBlockSafe(act1, act2)){
            const m = engine.evaluateMetrics();
            if(m.soBuoiDay1 < bestM.soBuoiDay1){
              bestM = { ...m };
              passImproved = true;
              resolved = true;
              console.log(`[BFS-2] Direct Swap: ${bestM.soBuoiDay1}`);
              break;
            }
          }
          engine.unplaceActivity(act1.id);
          engine.unplaceActivity(act2.id);
        }

        // If act2 cannot go to s1 (conflict with act2.gv at s1), try sending act2 to any slot s3 in act2.classId, or in another class c3 where act2.gv teaches!
        if(!resolved && r1.possible && r1.conflicts.length === 0){
          // Try intra-class s3
          for(let s3 = 0; s3 < 60; s3++){
            if(s3 === s1 || s3 === s2 || engine.offSlots.has(`${act1.classId}|${s3}`)) continue;
            const actId3 = cGrid1[s3];

            if(actId3 < 0){
              const r2to3 = engine.getConflictsForSlot(act2, s3);
              if(r2to3.possible && r2to3.conflicts.length === 0){
                engine.placeActivityDirect(act1.id, s2);
                engine.placeActivityDirect(act2.id, s3);

                if(engine.isLessonBlockSafe(act1, act2)){
                  const m = engine.evaluateMetrics();
                  if(m.soBuoiDay1 < bestM.soBuoiDay1){
                    bestM = { ...m };
                    passImproved = true;
                    resolved = true;
                    console.log(`[BFS-3] Intra-class empty s3: ${bestM.soBuoiDay1}`);
                    break;
                  }
                }
                engine.unplaceActivity(act1.id);
                engine.unplaceActivity(act2.id);
              }
            }else{
              const act3 = engine.activities[actId3];
              if(act3 && !act3.isFixed && act3.duration === 1){
                engine.unplaceActivity(act3.id);

                const r2to3 = engine.getConflictsForSlot(act2, s3);
                const r3to1 = engine.getConflictsForSlot(act3, s1);

                if(r2to3.possible && r2to3.conflicts.length === 0 && r3to1.possible && r3to1.conflicts.length === 0){
                  engine.placeActivityDirect(act1.id, s2);
                  engine.placeActivityDirect(act2.id, s3);
                  engine.placeActivityDirect(act3.id, s1);

                  if(engine.isLessonBlockSafe(act1, act2, act3)){
                    const m = engine.evaluateMetrics();
                    if(m.soBuoiDay1 < bestM.soBuoiDay1){
                      bestM = { ...m };
                      passImproved = true;
                      resolved = true;
                      console.log(`[BFS-3] Intra-class 3-way cycle: ${bestM.soBuoiDay1}`);
                      break;
                    }
                  }
                  engine.unplaceActivity(act1.id);
                  engine.unplaceActivity(act2.id);
                  engine.unplaceActivity(act3.id);
                }else{
                  engine.placeActivityDirect(act3.id, s3);
                }
              }
            }
            if(resolved) break;
          }
        }

        // Clean up unplaced
        engine.placeActivityDirect(act1.id, s1);
        engine.placeActivityDirect(act2.id, s2);

        if(resolved) break;
      }
      if(resolved) break;
    }

    if(!passImproved) break;
  }

  return bestM;
}

solveSingletonsViaBFS(opt, 50);
console.log("After BFS:", opt.evaluateMetrics());
