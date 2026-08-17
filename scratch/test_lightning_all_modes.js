const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

// Let's create an upgraded engine with zero-copy passes
let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Load engine
eval(engineCode);
const FetTimetableEngine = globalThis.FetTimetableEngine;

// Prototype upgrades on FetTimetableEngine
FetTimetableEngine.prototype.obliterateAllTeacherSingletons = function(maxPasses = 15, maxGap2Limit = Infinity){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let currentBest = this.evaluateMetrics();
  let anyImproved = false;

  for(let pass = 0; pass < maxPasses; pass++){
    if(currentBest.soBuoiDay1 <= 2) break;
    let passImproved = false;

    const teacherList = Array.from(this.teacherGrid.keys()).filter(Boolean);
    this.rng.shuffle(teacherList);

    for(const tKey of teacherList){
      const tGrid = this.teacherGrid.get(tKey);
      if(!tGrid) continue;

      for(let d = 0; d < DAYS; d++){
        for(let b = 0; b < SESSIONS; b++){
          const sStart = d * 10 + b * 5;
          const taught = [];
          for(let p = 0; p < PERIODS; p++){
            const s = sStart + p;
            if(tGrid[s] >= 0){
              const act = this.activities[tGrid[s]];
              if(act && !act.isFixed && act.duration === 1){
                taught.push({ slot: s, actId: tGrid[s], p });
              }
            }else if(tGrid[s] === -3){
              taught.push({ slot: s, actId: -3, p });
            }
          }

          if(taught.length !== 1 || taught[0].actId < 0) continue;

          const s1 = taught[0].slot;
          const act1 = this.activities[taught[0].actId];
          const cGrid = this.classGrid.get(act1.classId);
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
              if(this.offSlots.has(`${act1.classId}|${s2}`)) continue;
              if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

              const actId2 = cGrid[s2];

              // Case 1: Empty slot
              if(actId2 < 0){
                this.unplaceActivity(act1.id);
                const r1 = this.getConflictsForSlot(act1, s2);
                if(r1.possible && r1.conflicts.length === 0){
                  this.placeActivityDirect(act1.id, s2);
                  if(this.isLessonBlockSafe(act1)){
                    const m = this.evaluateMetrics();
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                      currentBest = { ...m };
                      anyImproved = true;
                      passImproved = true;
                      resolved = true;
                      break;
                    }
                  }
                  this.unplaceActivity(act1.id);
                }
                this.placeActivityDirect(act1.id, s1);
                continue;
              }

              // Case 2: 2-way swap
              const act2 = this.activities[actId2];
              if(!act2 || act2.isFixed || act2.duration !== 1) continue;

              const tGrid2 = this.teacherGrid.get(act2.gv);
              if(tGrid2 && tGrid2[s1] < 0 && tGrid2[s1] !== -3){
                this.unplaceActivity(act1.id);
                this.unplaceActivity(act2.id);

                const r1 = this.getConflictsForSlot(act1, s2);
                const r2 = this.getConflictsForSlot(act2, s1);

                if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                  this.placeActivityDirect(act1.id, s2);
                  this.placeActivityDirect(act2.id, s1);

                  if(this.isLessonBlockSafe(act1, act2)){
                    const m = this.evaluateMetrics();
                    if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                      currentBest = { ...m };
                      anyImproved = true;
                      passImproved = true;
                      resolved = true;
                      break;
                    }
                  }
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                }
                this.placeActivityDirect(act1.id, s1);
                this.placeActivityDirect(act2.id, s2);
              }
              if(resolved) break;

              // Case 3: 3-way Cyclic swap
              for(let s3 = 0; s3 < 60; s3++){
                if(s3 === s1 || s3 === s2 || this.offSlots.has(`${act1.classId}|${s3}`)) continue;
                const actId3 = cGrid[s3];

                if(actId3 < 0){
                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);

                  const r1 = this.getConflictsForSlot(act1, s2);
                  const r2 = this.getConflictsForSlot(act2, s3);

                  if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                    this.placeActivityDirect(act1.id, s2);
                    this.placeActivityDirect(act2.id, s3);

                    if(this.isLessonBlockSafe(act1, act2)){
                      const m = this.evaluateMetrics();
                      if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                        currentBest = { ...m };
                        anyImproved = true;
                        passImproved = true;
                        resolved = true;
                        break;
                      }
                    }
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);
                  }
                  this.placeActivityDirect(act1.id, s1);
                  this.placeActivityDirect(act2.id, s2);
                }else{
                  const act3 = this.activities[actId3];
                  if(!act3 || act3.isFixed || act3.duration !== 1) continue;

                  this.unplaceActivity(act1.id);
                  this.unplaceActivity(act2.id);
                  this.unplaceActivity(act3.id);

                  const r1 = this.getConflictsForSlot(act1, s2);
                  const r2 = this.getConflictsForSlot(act2, s3);
                  const r3 = this.getConflictsForSlot(act3, s1);

                  if(r1.possible && r1.conflicts.length === 0 &&
                     r2.possible && r2.conflicts.length === 0 &&
                     r3.possible && r3.conflicts.length === 0){
                    this.placeActivityDirect(act1.id, s2);
                    this.placeActivityDirect(act2.id, s3);
                    this.placeActivityDirect(act3.id, s1);

                    if(this.isLessonBlockSafe(act1, act2, act3)){
                      const m = this.evaluateMetrics();
                      if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                        currentBest = { ...m };
                        anyImproved = true;
                        passImproved = true;
                        resolved = true;
                        break;
                      }
                    }
                    this.unplaceActivity(act1.id);
                    this.unplaceActivity(act2.id);
                    this.unplaceActivity(act3.id);
                  }
                  this.placeActivityDirect(act1.id, s1);
                  this.placeActivityDirect(act2.id, s2);
                  this.placeActivityDirect(act3.id, s3);
                }
                if(resolved) break;
              }
            }
            if(resolved) break;
          }
        }
      }
    }
    if(!passImproved) break;
  }
  return anyImproved ? currentBest : null;
};

FetTimetableEngine.prototype.tryReinforceTeacherSingletons = function(bestMetrics, initialMetrics, maxGap2Limit = Infinity){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  let currentBest = { ...bestMetrics };
  let anyImproved = false;

  const teacherList = Array.from(this.teacherGrid.keys()).filter(Boolean);
  this.rng.shuffle(teacherList);

  for(const tKey of teacherList){
    const tGrid = this.teacherGrid.get(tKey);
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
                const act = this.activities[tGrid[s2]];
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
            const pullCGrid = this.classGrid.get(actToPull.classId);
            if(!pullCGrid) continue;

            for(let p = 0; p < PERIODS; p++){
              const sTarget = sStart + p;
              if(sTarget === singleSlot || this.offSlots.has(`${actToPull.classId}|${sTarget}`)) continue;
              if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

              const existingActId = pullCGrid[sTarget];

              if(existingActId < 0){
                this.unplaceActivity(actToPull.id);
                const r1 = this.getConflictsForSlot(actToPull, sTarget);
                if(r1.possible && r1.conflicts.length === 0){
                  this.placeActivityDirect(actToPull.id, sTarget);
                  if(this.isLessonBlockSafe(actToPull)){
                    const m = this.evaluateMetrics();
                    if(m.soBuoiDay1 < currentBest.soBuoiDay1 && m.soBuoiTrong2 <= maxGap2Limit){
                      currentBest = { ...m };
                      anyImproved = true;
                      reinResolved = true;
                      break;
                    }
                  }
                  this.unplaceActivity(actToPull.id);
                }
                this.placeActivityDirect(actToPull.id, item.slot);
              }else{
                const existingAct = this.activities[existingActId];
                if(!existingAct || existingAct.isFixed || existingAct.duration !== 1) continue;

                const existingTGrid = this.teacherGrid.get(existingAct.gv);
                if(existingTGrid && existingTGrid[item.slot] < 0 && existingTGrid[item.slot] !== -3){
                  this.unplaceActivity(actToPull.id);
                  this.unplaceActivity(existingAct.id);

                  const r1 = this.getConflictsForSlot(actToPull, sTarget);
                  const r2 = this.getConflictsForSlot(existingAct, item.slot);

                  if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                    this.placeActivityDirect(actToPull.id, sTarget);
                    this.placeActivityDirect(existingAct.id, item.slot);

                    if(this.isLessonBlockSafe(actToPull, existingAct)){
                      const m = this.evaluateMetrics();
                      if((m.soBuoiDay1 < currentBest.soBuoiDay1 || (m.soBuoiDay1 === currentBest.soBuoiDay1 && m.tsBuoiDay < currentBest.tsBuoiDay)) && m.soBuoiTrong2 <= maxGap2Limit){
                        currentBest = { ...m };
                        anyImproved = true;
                        reinResolved = true;
                        break;
                      }
                    }
                    this.unplaceActivity(actToPull.id);
                    this.unplaceActivity(existingAct.id);
                  }
                  this.placeActivityDirect(actToPull.id, item.slot);
                  this.placeActivityDirect(existingAct.id, sTarget);
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
  return anyImproved ? currentBest : null;
};

// Test optimize("optimize_singletons") with the upgraded routines
async function runTest(){
  const solver = new FetTimetableEngine(schoolData);
  solver.solve();
  schoolData.tkb = solver.getSnapshotTKB();

  const opt = new FetTimetableEngine(schoolData);
  const t0 = Date.now();
  console.log("Starting optimize_singletons test...");
  await opt.optimize("optimize_singletons");
  const elapsed = Date.now() - t0;
  const m = opt.evaluateMetrics();

  console.log(`\noptimize_singletons completed in ${elapsed}ms:`, m);
}

runTest();
