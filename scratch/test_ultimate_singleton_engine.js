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

// Implement the Ultimate Singleton Crusher
function obliterateAllSingletonsUltimate(engine, maxPasses = 30, maxGap2Limit = Infinity){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();
  let anyImproved = false;

  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;

  for(let pass = 0; pass < maxPasses; pass++){
    if(bestM.soBuoiDay1 <= 2) break;
    let passImp = false;

    const teacherList = Array.from(engine.teacherGrid.keys()).filter(Boolean);
    engine.rng.shuffle(teacherList);

    // =========================================================================
    // 1. OUTBOUND VACATE: Move 1-period lesson to a session with >= 1 periods
    // =========================================================================
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
                    if(m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                      bestM = { ...m };
                      anyImproved = true;
                      passImp = true;
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
              if(!act2 || act2.isFixed || act2.duration !== 1) continue;

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
                    if((m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                      bestM = { ...m };
                      anyImproved = true;
                      passImp = true;
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
                      if((m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                        bestM = { ...m };
                        anyImproved = true;
                        passImp = true;
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
                      if((m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                        bestM = { ...m };
                        anyImproved = true;
                        passImp = true;
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
            if(resolved) break;
          }
        }
      }
    }

    // =========================================================================
    // 2. INBOUND REINFORCE: Pull 1 period from a 3+ session into the 1-period session
    // =========================================================================
    for(const tKey of teacherList){
      const tGrid = engine.teacherGrid.get(tKey);
      if(!tGrid) continue;

      for(let d = 0; d < DAYS; d++){
        for(let b = 0; b < SESSIONS; b++){
          const sStart = d * 10 + b * 5;
          let taughtCount = 0;
          let singleSlot = -1;
          for(let p = 0; p < PERIODS; p++){
            const s = sStart + p;
            if(tGrid[s] >= 0 || tGrid[s] === -3){
              taughtCount++;
              singleSlot = s;
            }
          }
          if(taughtCount !== 1) continue;

          const richSessions = [];
          for(let d2 = 0; d2 < DAYS; d2++){
            for(let b2 = 0; b2 < SESSIONS; b2++){
              if(d2 === d && b2 === b) continue;
              const sStart2 = d2 * 10 + b2 * 5;
              const richTaught = [];
              for(let p2 = 0; p2 < PERIODS; p2++){
                const s2 = sStart2 + p2;
                if(tGrid[s2] >= 0){
                  const act = engine.activities[tGrid[s2]];
                  if(act && !act.isFixed && act.duration === 1){
                    richTaught.push({ slot: s2, act });
                  }
                }
              }
              if(richTaught.length >= 3){
                richSessions.push({ sStart: sStart2, richTaught });
              }
            }
          }

          let reinResolved = false;

          for(const rich of richSessions){
            for(const item of rich.richTaught){
              const actToPull = item.act;
              const pullCGrid = engine.classGrid.get(actToPull.classId);
              if(!pullCGrid) continue;

              for(let p = 0; p < PERIODS; p++){
                const sTarget = sStart + p;
                if(sTarget === singleSlot || engine.offSlots.has(`${actToPull.classId}|${sTarget}`)) continue;
                if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

                const existingActId = pullCGrid[sTarget];

                if(existingActId < 0){
                  engine.unplaceActivity(actToPull.id);
                  const r1 = engine.getConflictsForSlot(actToPull, sTarget);
                  if(r1.possible && r1.conflicts.length === 0){
                    engine.placeActivityDirect(actToPull.id, sTarget);
                    if(engine.isLessonBlockSafe(actToPull)){
                      const m = engine.evaluateMetrics();
                      if(m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                        bestM = { ...m };
                        anyImproved = true;
                        passImp = true;
                        reinResolved = true;
                        break;
                      }
                    }
                    engine.unplaceActivity(actToPull.id);
                  }
                  engine.placeActivityDirect(actToPull.id, item.slot);
                }else{
                  const existingAct = engine.activities[existingActId];
                  if(!existingAct || existingAct.isFixed || existingAct.duration !== 1) continue;

                  const existingTGrid = engine.teacherGrid.get(existingAct.gv);
                  if(existingTGrid && existingTGrid[item.slot] < 0 && existingTGrid[item.slot] !== -3){
                    engine.unplaceActivity(actToPull.id);
                    engine.unplaceActivity(existingAct.id);

                    const r1 = engine.getConflictsForSlot(actToPull, sTarget);
                    const r2 = engine.getConflictsForSlot(existingAct, item.slot);

                    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                      engine.placeActivityDirect(actToPull.id, sTarget);
                      engine.placeActivityDirect(existingAct.id, item.slot);

                      if(engine.isLessonBlockSafe(actToPull, existingAct)){
                        const m = engine.evaluateMetrics();
                        if((m.soBuoiDay1 < bestM.soBuoiDay1 || (m.soBuoiDay1 === bestM.soBuoiDay1 && m.tsBuoiDay < bestM.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                          bestM = { ...m };
                          anyImproved = true;
                          passImp = true;
                          reinResolved = true;
                          break;
                        }
                      }
                      engine.unplaceActivity(actToPull.id);
                      engine.unplaceActivity(existingAct.id);
                    }
                    engine.placeActivityDirect(actToPull.id, item.slot);
                    engine.placeActivityDirect(existingAct.id, sTarget);
                  }
                }
                if(reinResolved) break;
              }
              if(reinResolved) break;
            }
            if(reinResolved) break;
          }
        }
      }
    }

    // =========================================================================
    // 3. SAME-CLASS MERGE: Pair singletons of the same teacher in the same class
    // =========================================================================
    for(const tKey of teacherList){
      const tGrid = engine.teacherGrid.get(tKey);
      if(!tGrid) continue;

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
            if(sessA === sessB) continue;

            let cntA = 0, cntB = 0;
            for(let p = 0; p < 5; p++){
              if(tGrid[sessA * 5 + p] >= 0 || tGrid[sessA * 5 + p] === -3) cntA++;
              if(tGrid[sessB * 5 + p] >= 0 || tGrid[sessB * 5 + p] === -3) cntB++;
            }

            if(cntA === 1 || cntB === 1){
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
                      if(m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                        bestM = { ...m };
                        passImp = true;
                        anyImproved = true;
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
                        if(m.soBuoiDay1 < bestM.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                          bestM = { ...m };
                          passImp = true;
                          anyImproved = true;
                          break;
                        }
                      }
                      engine.unplaceActivity(itemA.act.id);
                      engine.unplaceActivity(actDst.id);
                    }
                    engine.placeActivityDirect(itemA.act.id, itemA.slot);
                    engine.placeActivityDirect(actDst.id, sTarget);
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

  console.log(`Ultimate Crusher finished in ${Date.now() - t0}ms:`, bestM);
  return anyImproved ? bestM : null;
}

obliterateAllSingletonsUltimate(opt);
