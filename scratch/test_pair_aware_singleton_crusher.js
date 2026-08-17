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

// Let's implement Pair-Aware and Multi-Hop Singleton Ejection
function obliterateSingletonsPairAware(engine, maxPasses = 30){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();

  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;

  for(let pass = 0; pass < maxPasses; pass++){
    if(bestM.soBuoiDay1 <= 2) break;
    let passImp = false;

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

          // Target all sessions where teacher tKey teaches >= 1 periods, OR empty sessions in other days
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

              // 1. Empty slot in class
              if(actId2 < 0){
                engine.unplaceActivity(act1.id);
                const r1 = engine.getConflictsForSlot(act1, s2);
                if(r1.possible && r1.conflicts.length === 0){
                  engine.placeActivityDirect(act1.id, s2);
                  if(engine.isLessonBlockSafe(act1)){
                    const m = engine.evaluateMetrics();
                    if(m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)){
                      bestM = { ...m };
                      passImp = true;
                      resolved = true;
                      console.log(`[Pair-Aware] Empty move: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                      break;
                    }
                  }
                  engine.unplaceActivity(act1.id);
                }
                engine.placeActivityDirect(act1.id, s1);
                continue;
              }

              // 2. 1-period swap
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
                      if(m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)){
                        bestM = { ...m };
                        passImp = true;
                        resolved = true;
                        console.log(`[Pair-Aware] 1-period swap: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                        break;
                      }
                    }
                    engine.unplaceActivity(act1.id);
                    engine.unplaceActivity(act2.id);
                  }
                  engine.placeActivityDirect(act1.id, s1);
                  engine.placeActivityDirect(act2.id, s2);
                }

                // 3-way cycle with another slot s3
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
                        if(m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)){
                          bestM = { ...m };
                          passImp = true;
                          resolved = true;
                          console.log(`[Pair-Aware] 3-way to empty: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
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
                        if(m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)){
                          bestM = { ...m };
                          passImp = true;
                          resolved = true;
                          console.log(`[Pair-Aware] 3-way cycle: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
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

              // 3. Pair-Swap (act2.duration === 2):
              // If act2 is a duration=2 pair (occupying s2 and s2+1), we can relocate the pair act2 to another session where act2 fits, and place act1 at s2!
              else if(act2.duration === 2){
                // Find all candidate target pair slots for act2 in this class
                for(let d3 = 0; d3 < DAYS; d3++){
                  for(let b3 = 0; b3 < SESSIONS; b3++){
                    if(d3 === Math.floor(tgt.sStart / 10) && b3 === Math.floor((tgt.sStart % 10) / 5)) continue;
                    const sStart3 = d3 * 10 + b3 * 5;

                    for(let p3 = 0; p3 < 4; p3++){
                      const pairSlot3 = sStart3 + p3;
                      if(engine.offSlots.has(`${act1.classId}|${pairSlot3}`) || engine.offSlots.has(`${act1.classId}|${pairSlot3 + 1}`)) continue;

                      const idA = cGrid[pairSlot3];
                      const idB = cGrid[pairSlot3 + 1];

                      // If pairSlot3 has 2 single-period activities actA, actB
                      if(idA >= 0 && idB >= 0){
                        const actA = engine.activities[idA];
                        const actB = engine.activities[idB];
                        if(actA && !actA.isFixed && actA.duration === 1 && actB && !actB.isFixed && actB.duration === 1){
                          // Try: move act2 (pair) to pairSlot3. Move actA to s1. Move act1 to s2. Move actB to s2+1!
                          const pairSlot2 = engine.actPlacement[act2.id]; // starting slot of act2

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
                              if(m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)){
                                bestM = { ...m };
                                passImp = true;
                                resolved = true;
                                console.log(`[Pair-Aware] Pair Displacement: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
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
    if(!passImp) break;
  }

  console.log(`Finished in ${Date.now() - t0}ms:`, bestM);
  return bestM;
}

obliterateSingletonsPairAware(opt);
