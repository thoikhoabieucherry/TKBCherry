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

// Let's run a multi-hop deep singleton optimizer
function deepEliminateSingletons(engine, maxPasses = 50){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let currentBest = engine.evaluateMetrics();

  for(let pass = 0; pass < maxPasses; pass++){
    if(currentBest.soBuoiDay1 <= 2) break;
    let anyPassImp = false;

    const teacherList = Array.from(engine.teacherGrid.keys()).filter(Boolean);
    engine.rng.shuffle(teacherList);

    for(const tKey of teacherList){
      const tGrid = engine.teacherGrid.get(tKey);
      if(!tGrid) continue;

      for(let d = 0; d < DAYS; d++){
        for(let b = 0; b < SESSIONS; b++){
          const sStart = d * 10 + b * 5;
          const taught = [];
          for(let p = 0; p < PERIODS; p++){
            const s = sStart + p;
            if(tGrid[s] >= 0){
              const act = engine.activities[tGrid[s]];
              if(act && !act.isFixed && act.duration === 1){
                taught.push({ slot: s, actId: tGrid[s], p });
              }
            }else if(tGrid[s] === -3){
              taught.push({ slot: s, actId: -3, p });
            }
          }

          if(taught.length !== 1 || taught[0].actId < 0) continue;

          const s1 = taught[0].slot;
          const act1 = engine.activities[taught[0].actId];
          const cGrid = engine.classGrid.get(act1.classId);
          if(!cGrid) continue;

          // Target ANY session in the class
          const targetSessions = [];
          for(let d2 = 0; d2 < DAYS; d2++){
            for(let b2 = 0; b2 < SESSIONS; b2++){
              if(d2 === d && b2 === b) continue;
              const sStart2 = d2 * 10 + b2 * 5;
              let cnt = 0;
              for(let p2 = 0; p2 < PERIODS; p2++){
                if(tGrid[sStart2 + p2] >= 0 || tGrid[sStart2 + p2] === -3) cnt++;
              }
              if(cnt >= 1 && cnt < 5){
                targetSessions.push({ sStart: sStart2, cnt });
              }
            }
          }
          targetSessions.sort((x, y) => y.cnt - x.cnt);

          let resolved = false;
          for(const tgt of targetSessions){
            for(let p2 = 0; p2 < PERIODS; p2++){
              const s2 = tgt.sStart + p2;
              if(engine.offSlots.has(`${act1.classId}|${s2}`)) continue;
              if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

              const actId2 = cGrid[s2];
              if(actId2 < 0){
                engine.unplaceActivity(act1.id);
                const r1 = engine.getConflictsForSlot(act1, s2);
                if(r1.possible && r1.conflicts.length === 0){
                  engine.placeActivityDirect(act1.id, s2);
                  if(engine.isLessonBlockSafe(act1)){
                    const m = engine.evaluateMetrics();
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)){
                      currentBest = { ...m };
                      anyPassImp = true;
                      resolved = true;
                      break;
                    }
                  }
                  engine.unplaceActivity(act1.id);
                }
                engine.placeActivityDirect(act1.id, s1);
                continue;
              }

              const act2 = engine.activities[actId2];
              if(!act2 || act2.isFixed || act2.duration !== 1) continue;

              // 2-way
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
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)){
                      currentBest = { ...m };
                      anyPassImp = true;
                      resolved = true;
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

              // 3-way within same class
              for(let s3 = 0; s3 < 60; s3++){
                if(s3 === s1 || s3 === s2 || engine.offSlots.has(`${act1.classId}|${s3}`)) continue;
                const actId3 = cGrid[s3];
                if(actId3 < 0){
                  engine.unplaceActivity(act1.id);
                  engine.unplaceActivity(act2.id);

                  const r1 = engine.getConflictsForSlot(act1, s2);
                  const r2 = engine.getConflictsForSlot(act2, s3);

                  if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                    engine.placeActivityDirect(act1.id, s2);
                    engine.placeActivityDirect(act2.id, s3);

                    if(engine.isLessonBlockSafe(act1, act2)){
                      const m = engine.evaluateMetrics();
                      if(m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)){
                        currentBest = { ...m };
                        anyPassImp = true;
                        resolved = true;
                        break;
                      }
                    }
                    engine.unplaceActivity(act1.id);
                    engine.unplaceActivity(act2.id);
                  }
                  engine.placeActivityDirect(act1.id, s1);
                  engine.placeActivityDirect(act2.id, s2);
                }else{
                  const act3 = engine.activities[actId3];
                  if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                  engine.unplaceActivity(act1.id);
                  engine.unplaceActivity(act2.id);
                  engine.unplaceActivity(act3.id);

                  const r1 = engine.getConflictsForSlot(act1, s2);
                  const r2 = engine.getConflictsForSlot(act2, s3);
                  const r3 = engine.getConflictsForSlot(act3, s1);

                  if(r1.possible && r1.conflicts.length === 0 &&
                     r2.possible && r2.conflicts.length === 0 &&
                     r3.possible && r3.conflicts.length === 0){
                    engine.placeActivityDirect(act1.id, s2);
                    engine.placeActivityDirect(act2.id, s3);
                    engine.placeActivityDirect(act3.id, s1);

                    if(engine.isLessonBlockSafe(act1, act2, act3)){
                      const m = engine.evaluateMetrics();
                      if(m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)){
                        currentBest = { ...m };
                        anyPassImp = true;
                        resolved = true;
                        break;
                      }
                    }
                    engine.unplaceActivity(act1.id);
                    engine.unplaceActivity(act2.id);
                    engine.unplaceActivity(act3.id);
                  }
                  engine.placeActivityDirect(act1.id, s1);
                  engine.placeActivityDirect(act2.id, s2);
                  engine.placeActivityDirect(act3.id, s3);
                }
                if(resolved) break;
              }
              if(resolved) break;

              // Cross-Class 3-Way Ejection Chain:
              // act1 moves to s2. act2 moves to slot s3 in ANOTHER class cOther where teacher act2.gv also teaches!
              const act2GVGrid = engine.teacherGrid.get(act2.gv);
              if(act2GVGrid){
                for(const act2OtherAct of engine.activities){
                  if(act2OtherAct.gv !== act2.gv || act2OtherAct.classId === act1.classId || act2OtherAct.duration !== 1 || act2OtherAct.isFixed) continue;
                  const cOtherGrid = engine.classGrid.get(act2OtherAct.classId);
                  if(!cOtherGrid) continue;

                  for(let sOther = 0; sOther < 60; sOther++){
                    if(sOther === s1 || sOther === s2 || engine.offSlots.has(`${act2OtherAct.classId}|${sOther}`)) continue;
                    const actIdOther = cOtherGrid[sOther];
                    if(actIdOther < 0){
                      // Try: act1 -> s2, act2 -> s1, act2OtherAct -> sOther
                      // Wait: act2 moves to sOther!
                      engine.unplaceActivity(act1.id);
                      engine.unplaceActivity(act2.id);

                      const r1 = engine.getConflictsForSlot(act1, s2);
                      const r2 = engine.getConflictsForSlot(act2, sOther);

                      if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                        // But class act1.classId needs a lesson at s1!
                        // What if act1 -> s2, and an activity from another slot in act1.classId goes to s1? That's already 3-way.
                      }
                      engine.placeActivityDirect(act1.id, s1);
                      engine.placeActivityDirect(act2.id, s2);
                    }
                  }
                }
              }
            }
            if(resolved) break;
          }
        }
      }
    }
    if(!anyPassImp) break;
  }
  return currentBest;
}

opt.optimize('optimize_singletons').then(() => {
  console.log("Singletons after standard:", opt.evaluateMetrics());
  deepEliminateSingletons(opt, 30);
  console.log("Singletons after deep:", opt.evaluateMetrics());
});
