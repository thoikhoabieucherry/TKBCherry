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

// Improved Reinforce: checks total periods >= 3 in session
function improvedReinforce(engine){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let currentBest = engine.evaluateMetrics();
  let anyImproved = false;

  for(let pass = 0; pass < 20; pass++){
    let passImp = false;
    const teacherList = Array.from(engine.teacherGrid.keys()).filter(Boolean);
    engine.rng.shuffle(teacherList);

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

          // Find sessions where this teacher teaches >= 3 periods in total
          const richSessions = [];
          for(let d2 = 0; d2 < DAYS; d2++){
            for(let b2 = 0; b2 < SESSIONS; b2++){
              if(d2 === d && b2 === b) continue;
              const sStart2 = d2 * 10 + b2 * 5;
              let totalPeriods = 0;
              const movableActs = [];
              for(let p2 = 0; p2 < PERIODS; p2++){
                const s2 = sStart2 + p2;
                if(tGrid[s2] >= 0){
                  totalPeriods++;
                  const act = engine.activities[tGrid[s2]];
                  if(act && !act.isFixed && act.duration === 1){
                    movableActs.push({ slot: s2, act });
                  }
                }else if(tGrid[s2] === -3){
                  totalPeriods++;
                }
              }
              if(totalPeriods >= 3 && movableActs.length >= 1){
                richSessions.push({ sStart: sStart2, movableActs, totalPeriods });
              }
            }
          }

          let reinResolved = false;
          for(const rich of richSessions){
            for(const item of rich.movableActs){
              const actToPull = item.act;
              const pullCGrid = engine.classGrid.get(actToPull.classId);
              if(!pullCGrid) continue;

              for(let p = 0; p < PERIODS; p++){
                const sTarget = sStart + p;
                if(sTarget === singleSlot || engine.offSlots.has(`${actToPull.classId}|${sTarget}`)) continue;
                if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

                const existingActId = pullCGrid[sTarget];

                // 1. Empty slot
                if(existingActId < 0){
                  engine.unplaceActivity(actToPull.id);
                  const r1 = engine.getConflictsForSlot(actToPull, sTarget);
                  if(r1.possible && r1.conflicts.length === 0){
                    engine.placeActivityDirect(actToPull.id, sTarget);
                    if(engine.isLessonBlockSafe(actToPull)){
                      const m = engine.evaluateMetrics();
                      if(m.soBuoiDay1 < currentBest.soBuoiDay1){
                        currentBest = { ...m };
                        anyImproved = true;
                        passImp = true;
                        reinResolved = true;
                        console.log(`[Reinforce-Empty] singletons -> ${m.soBuoiDay1}`);
                        break;
                      }
                    }
                    engine.unplaceActivity(actToPull.id);
                  }
                  engine.placeActivityDirect(actToPull.id, item.slot);
                }
                // 2. 2-way swap
                else{
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
                        if(m.soBuoiDay1 < currentBest.soBuoiDay1){
                          currentBest = { ...m };
                          anyImproved = true;
                          passImp = true;
                          reinResolved = true;
                          console.log(`[Reinforce-Swap] singletons -> ${m.soBuoiDay1}`);
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
    if(!passImp) break;
  }
  return currentBest;
}

// Also Pair-Aware Vacate:
function vacateSingletons(engine){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let currentBest = engine.evaluateMetrics();
  let anyImproved = false;

  for(let pass = 0; pass < 20; pass++){
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

          // Target ANY session where teacher teaches >= 1 periods, sorted by most periods first
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
                      anyImproved = true;
                      passImp = true;
                      resolved = true;
                      console.log(`[Vacate-Empty] singletons -> ${m.soBuoiDay1}`);
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
                      passImp = true;
                      resolved = true;
                      console.log(`[Vacate-Swap] singletons -> ${m.soBuoiDay1}`);
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

              // 3-way cyclic swap
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
                        passImp = true;
                        resolved = true;
                        console.log(`[Vacate-3way-Empty] singletons -> ${m.soBuoiDay1}`);
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
                        passImp = true;
                        resolved = true;
                        console.log(`[Vacate-3way-Cycle] singletons -> ${m.soBuoiDay1}`);
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
            }
            if(resolved) break;
          }
        }
      }
    }
    if(!passImp) break;
  }
  return currentBest;
}

// Loop interleaving Vacate and Reinforce
for(let iter = 0; iter < 10; iter++){
  const m1 = vacateSingletons(opt);
  const m2 = improvedReinforce(opt);
  console.log(`Iteration ${iter+1}: singletons = ${opt.evaluateMetrics().soBuoiDay1}`);
}
