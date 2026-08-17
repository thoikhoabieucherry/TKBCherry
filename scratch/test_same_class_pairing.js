const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

console.log("Initial metrics:", opt.evaluateMetrics());

// First run lightning optimizer
const testScript = fs.readFileSync('scratch/test_lightning_singleton_optimizer.js', 'utf8');
eval(testScript.replace('optimizeSingletonsLightning(opt, 5000);', ''));
optimizeSingletonsLightning(opt, 3000);

console.log("Metrics after lightning:", opt.evaluateMetrics());

// Now run Same-Teacher Same-Class Pair Merging:
function mergeTeacherSameClassSingletons(engine){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();
  let improved = false;

  const teachers = Array.from(engine.teacherGrid.keys()).filter(Boolean);

  for(let pass = 0; pass < 20; pass++){
    if(bestM.soBuoiDay1 <= 2) break;
    let passImp = false;

    for(const gv of teachers){
      const tGrid = engine.teacherGrid.get(gv);
      if(!tGrid) continue;

      // Group activities of this teacher by class
      const actsByClass = new Map();
      for(let s = 0; s < 60; s++){
        if(tGrid[s] >= 0){
          const act = engine.activities[tGrid[s]];
          if(act && !act.isFixed && act.duration === 1){
            if(!actsByClass.has(act.classId)) actsByClass.set(act.classId, []);
            actsByClass.get(act.classId).push({ slot: s, act });
          }
        }
      }

      for(const [cid, list] of actsByClass.entries()){
        if(list.length < 2) continue;
        const cGrid = engine.classGrid.get(cid);
        if(!cGrid) continue;

        for(let i = 0; i < list.length; i++){
          for(let j = i + 1; j < list.length; j++){
            const itemA = list[i];
            const itemB = list[j];

            const sessA = Math.floor(itemA.slot / 5);
            const sessB = Math.floor(itemB.slot / 5);
            if(sessA === sessB) continue; // Already in same session

            // Count periods taught by gv in sessA and sessB
            let cntA = 0, cntB = 0;
            for(let p = 0; p < 5; p++){
              if(tGrid[sessA * 5 + p] >= 0 || tGrid[sessA * 5 + p] === -3) cntA++;
              if(tGrid[sessB * 5 + p] >= 0 || tGrid[sessB * 5 + p] === -3) cntB++;
            }

            // If sessA is 1 period or sessB is 1 period:
            if(cntA === 1 || cntB === 1){
              // Try moving itemA into sessB, or itemB into sessA!
              // Option 1: Move itemA into sessB
              for(let p2 = 0; p2 < 5; p2++){
                const sTarget = sessB * 5 + p2;
                if(sTarget === itemB.slot || engine.offSlots.has(`${cid}|${sTarget}`)) continue;
                if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

                const actIdDst = cGrid[sTarget];
                if(actIdDst < 0){
                  engine.unplaceActivity(itemA.act.id);
                  if(engine.getConflictsForSlot(itemA.act, sTarget).possible && engine.getConflictsForSlot(itemA.act, sTarget).conflicts.length === 0){
                    engine.placeActivityDirect(itemA.act.id, sTarget);
                    if(engine.isLessonBlockSafe(itemA.act)){
                      const m = engine.evaluateMetrics();
                      if(m.soBuoiDay1 < bestM.soBuoiDay1){
                        bestM = { ...m };
                        passImp = true;
                        improved = true;
                        console.log(`[Same-Class Merge] Empty target: singletons -> ${bestM.soBuoiDay1}`);
                        break;
                      }
                    }
                    engine.unplaceActivity(itemA.act.id);
                  }
                  engine.placeActivityDirect(itemA.act.id, itemA.slot);
                }else{
                  const actDst = engine.activities[actIdDst];
                  if(!actDst || actDst.isFixed || actDst.duration !== 1) continue;

                  const tDstGrid = engine.teacherGrid.get(actDst.gv);
                  if(tDstGrid && tDstGrid[itemA.slot] < 0 && tDstGrid[itemA.slot] !== -3){
                    engine.unplaceActivity(itemA.act.id);
                    engine.unplaceActivity(actDst.id);

                    const r1 = engine.getConflictsForSlot(itemA.act, sTarget);
                    const r2 = engine.getConflictsForSlot(actDst, itemA.slot);

                    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                      engine.placeActivityDirect(itemA.act.id, sTarget);
                      engine.placeActivityDirect(actDst.id, itemA.slot);

                      if(engine.isLessonBlockSafe(itemA.act, actDst)){
                        const m = engine.evaluateMetrics();
                        if(m.soBuoiDay1 < bestM.soBuoiDay1){
                          bestM = { ...m };
                          passImp = true;
                          improved = true;
                          console.log(`[Same-Class Merge] 2-way swap: singletons -> ${bestM.soBuoiDay1}`);
                          break;
                        }
                      }
                      engine.unplaceActivity(itemA.act.id);
                      engine.unplaceActivity(actDst.id);
                    }
                    engine.placeActivityDirect(itemA.act.id, itemA.slot);
                    engine.placeActivityDirect(actDst.id, sTarget);
                  }

                  // 3-way swap inside class C
                  for(let s3 = 0; s3 < 60; s3++){
                    if(s3 === itemA.slot || s3 === sTarget || engine.offSlots.has(`${cid}|${s3}`)) continue;
                    const actId3 = cGrid[s3];
                    if(actId3 < 0) continue;
                    const act3 = engine.activities[actId3];
                    if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                    engine.unplaceActivity(itemA.act.id);
                    engine.unplaceActivity(actDst.id);
                    engine.unplaceActivity(act3.id);

                    const r1 = engine.getConflictsForSlot(itemA.act, sTarget);
                    const r2 = engine.getConflictsForSlot(actDst, s3);
                    const r3 = engine.getConflictsForSlot(act3, itemA.slot);

                    if(r1.possible && r1.conflicts.length === 0 &&
                       r2.possible && r2.conflicts.length === 0 &&
                       r3.possible && r3.conflicts.length === 0){
                      engine.placeActivityDirect(itemA.act.id, sTarget);
                      engine.placeActivityDirect(actDst.id, s3);
                      engine.placeActivityDirect(act3.id, itemA.slot);

                      if(engine.isLessonBlockSafe(itemA.act, actDst, act3)){
                        const m = engine.evaluateMetrics();
                        if(m.soBuoiDay1 < bestM.soBuoiDay1){
                          bestM = { ...m };
                          passImp = true;
                          improved = true;
                          console.log(`[Same-Class Merge] 3-way cycle: singletons -> ${bestM.soBuoiDay1}`);
                          break;
                        }
                      }
                      engine.unplaceActivity(itemA.act.id);
                      engine.unplaceActivity(actDst.id);
                      engine.unplaceActivity(act3.id);
                    }
                    engine.placeActivityDirect(itemA.act.id, itemA.slot);
                    engine.placeActivityDirect(actDst.id, sTarget);
                    engine.placeActivityDirect(act3.id, s3);
                  }
                }
              }
            }
          }
        }
      }
    }
    if(!passImp) break;
  }

  console.log(`Same-Class Merge finished in ${Date.now() - t0}ms:`, bestM);
  return bestM;
}

mergeTeacherSameClassSingletons(opt);
