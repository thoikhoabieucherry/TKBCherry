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

console.log("Initial metrics:", opt.evaluateMetrics());

// Obliterate with Pair Displacement
function obliterateWithPairDisplacement(engine, maxPasses = 30){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let currentBest = engine.evaluateMetrics();
  let anyImproved = false;

  for(let pass = 0; pass < maxPasses; pass++){
    if(currentBest.soBuoiDay1 <= 2) break;
    let passImproved = false;

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

              // Case 1: Empty slot
              if(actId2 < 0){
                engine.unplaceActivity(act1.id);
                const r1 = engine.getConflictsForSlot(act1, s2);
                if(r1.possible && r1.conflicts.length === 0){
                  engine.placeActivityDirect(act1.id, s2);
                  if(engine.isLessonBlockSafe(act1)){
                    const m = engine.evaluateMetrics();
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1){
                      currentBest = { ...m };
                      anyImproved = true;
                      passImproved = true;
                      resolved = true;
                      break;
                    }
                  }
                  engine.unplaceActivity(act1.id);
                }
                engine.placeActivityDirect(act1.id, s1);
                continue;
              }

              // Case 2: 2-way swap
              const act2 = engine.activities[actId2];
              if(!act2 || act2.isFixed) continue;

              if(act2.duration === 1){
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
                        anyImproved = true;
                        passImproved = true;
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

                // Case 3: 3-way Cyclic swap
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
                          anyImproved = true;
                          passImproved = true;
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
                          anyImproved = true;
                          passImproved = true;
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
              }
              // Case 4: Pair Displacement (act2 is duration = 2)
              else if(act2.duration === 2){
                for(let d3 = 0; d3 < DAYS; d3++){
                  for(let b3 = 0; b3 < SESSIONS; b3++){
                    if(d3 === Math.floor(tgt.sStart / 10) && b3 === Math.floor((tgt.sStart % 10) / 5)) continue;
                    const sStart3 = d3 * 10 + b3 * 5;

                    for(let p3 = 0; p3 < 4; p3++){
                      const pairSlot3 = sStart3 + p3;
                      if(engine.offSlots.has(`${act1.classId}|${pairSlot3}`) || engine.offSlots.has(`${act1.classId}|${pairSlot3 + 1}`)) continue;

                      const idA = cGrid[pairSlot3];
                      const idB = cGrid[pairSlot3 + 1];

                      if(idA >= 0 && idB >= 0){
                        const actA = engine.activities[idA];
                        const actB = engine.activities[idB];
                        if(actA && !actA.isFixed && actA.duration === 1 && actB && !actB.isFixed && actB.duration === 1){
                          const pairSlot2 = engine.actPlacement[act2.id];

                          engine.unplaceActivity(act1.id);
                          engine.unplaceActivity(act2.id);
                          engine.unplaceActivity(actA.id);
                          engine.unplaceActivity(actB.id);

                          const r2 = engine.getConflictsForSlot(act2, pairSlot3);
                          const r1 = engine.getConflictsForSlot(act1, pairSlot2);
                          const rB = engine.getConflictsForSlot(actB, pairSlot2 + 1);
                          const rA = engine.getConflictsForSlot(actA, s1);

                          if(r2.possible && r2.conflicts.length === 0 &&
                             r1.possible && r1.conflicts.length === 0 &&
                             rB.possible && rB.conflicts.length === 0 &&
                             rA.possible && rA.conflicts.length === 0){
                            engine.placeActivityDirect(act2.id, pairSlot3);
                            engine.placeActivityDirect(act1.id, pairSlot2);
                            engine.placeActivityDirect(actB.id, pairSlot2 + 1);
                            engine.placeActivityDirect(actA.id, s1);

                            if(engine.isLessonBlockSafe(act1, act2, actA, actB)){
                              const m = engine.evaluateMetrics();
                              if(m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)){
                                currentBest = { ...m };
                                anyImproved = true;
                                passImproved = true;
                                resolved = true;
                                break;
                              }
                            }
                            engine.unplaceActivity(act2.id);
                            engine.unplaceActivity(act1.id);
                            engine.unplaceActivity(actB.id);
                            engine.unplaceActivity(actA.id);
                          }
                          engine.placeActivityDirect(act1.id, s1);
                          engine.placeActivityDirect(act2.id, pairSlot2);
                          engine.placeActivityDirect(actA.id, pairSlot3);
                          engine.placeActivityDirect(actB.id, pairSlot3 + 1);
                        }
                      }
                      if(resolved) break;
                    }
                    if(resolved) break;
                  }
                  if(resolved) break;
                }
              }
              if(resolved) break;
            }
            if(resolved) break;
          }
        }
      }
    }
    if(!passImproved) break;
  }
  return anyImproved ? currentBest : null;
}

const res = obliterateWithPairDisplacement(opt, 30);
console.log("After Pair-Displacement Obliteration:", opt.evaluateMetrics());
