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

// Let's implement the Multi-Strategy Singleton Crusher
function findSingletons(engine){
  const res = [];
  for(const [gv, grid] of engine.teacherGrid.entries()){
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
          const act = engine.activities[taught[0].actId];
          if(act && !act.isFixed && act.duration === 1){
            res.push({ gv, day: d, session: b, slot: taught[0].slot, actId: taught[0].actId, classId: act.classId });
          }
        }
      }
    }
  }
  return res;
}

function runUltimateOptimizer(engine, maxTimeMs = 15000){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();
  console.log(`Starting Ultimate Optimizer with initial singletons = ${bestM.soBuoiDay1}...`);

  // Outer loop: alternating between Outbound Vacate (Ejection) and Inbound Reinforce
  for(let round = 0; round < 200; round++){
    if(bestM.soBuoiDay1 <= 2) break;
    if(Date.now() - t0 > maxTimeMs) break;

    let roundImproved = false;

    // STRATEGY 1: OUTBOUND VACATE (Move singleton lesson out into a rich session)
    const singletons = findSingletons(engine);
    engine.rng.shuffle(singletons);

    for(const single of singletons){
      const act1 = engine.activities[single.actId];
      if(!act1 || act1.duration !== 1) continue;
      const cGrid = engine.classGrid.get(act1.classId);
      const tGrid = engine.teacherGrid.get(single.gv);
      if(!cGrid || !tGrid) continue;

      // Candidate sessions
      const targetSessions = [];
      for(let d = 0; d < 6; d++){
        for(let b = 0; b < 2; b++){
          if(d === single.day && b === single.session) continue;
          const sStart = d * 10 + b * 5;
          let tCount = 0;
          for(let p = 0; p < 5; p++){
            if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) tCount++;
          }
          // Prioritize sessions with >= 1 periods
          targetSessions.push({ day: d, session: b, sStart, tCount });
        }
      }
      targetSessions.sort((a, b) => b.tCount - a.tCount);

      let resolved = false;

      for(const sess of targetSessions){
        for(let p = 0; p < 5; p++){
          const s2 = sess.sStart + p;
          if(engine.offSlots.has(`${act1.classId}|${s2}`)) continue;
          if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

          const actId2 = cGrid[s2];

          // 1A. Direct move to empty slot
          if(actId2 < 0){
            engine.unplaceActivity(act1.id);
            const r1 = engine.getConflictsForSlot(act1, s2);
            if(r1.possible && r1.conflicts.length === 0){
              engine.placeActivityDirect(act1.id, s2);
              if(engine.isLessonBlockSafe(act1)){
                const newM = engine.evaluateMetrics();
                if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                  bestM = { ...newM };
                  roundImproved = true;
                  resolved = true;
                  console.log(`[${Date.now() - t0}ms] Direct empty slot: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                  break;
                }
              }
              engine.unplaceActivity(act1.id);
            }
            engine.placeActivityDirect(act1.id, single.slot);
            continue;
          }

          // 1B. 2-way swap
          const act2 = engine.activities[actId2];
          if(!act2 || act2.isFixed || act2.duration !== 1) continue;
          const tGrid2 = engine.teacherGrid.get(act2.gv);

          if(tGrid2 && tGrid2[single.slot] < 0 && tGrid2[single.slot] !== -3){
            engine.unplaceActivity(act1.id);
            engine.unplaceActivity(act2.id);

            const r1 = engine.getConflictsForSlot(act1, s2);
            const r2 = engine.getConflictsForSlot(act2, single.slot);

            if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
              engine.placeActivityDirect(act1.id, s2);
              engine.placeActivityDirect(act2.id, single.slot);

              if(engine.isLessonBlockSafe(act1, act2)){
                const newM = engine.evaluateMetrics();
                if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                  bestM = { ...newM };
                  roundImproved = true;
                  resolved = true;
                  console.log(`[${Date.now() - t0}ms] 2-way swap: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                  break;
                }
              }
              engine.unplaceActivity(act1.id);
              engine.unplaceActivity(act2.id);
            }
            engine.placeActivityDirect(act1.id, single.slot);
            engine.placeActivityDirect(act2.id, s2);
          }
          if(resolved) break;

          // 1C. 3-way Cyclic swap
          for(let s3 = 0; s3 < 60; s3++){
            if(s3 === single.slot || s3 === s2) continue;
            if(engine.offSlots.has(`${act1.classId}|${s3}`)) continue;
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
                  const newM = engine.evaluateMetrics();
                  if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                    bestM = { ...newM };
                    roundImproved = true;
                    resolved = true;
                    console.log(`[${Date.now() - t0}ms] 2-hop to empty s3: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                    break;
                  }
                }
                engine.unplaceActivity(act1.id);
                engine.unplaceActivity(act2.id);
              }
              engine.placeActivityDirect(act1.id, single.slot);
              engine.placeActivityDirect(act2.id, s2);
            }else{
              const act3 = engine.activities[actId3];
              if(!act3 || act3.isFixed || act3.duration !== 1) continue;

              engine.unplaceActivity(act1.id);
              engine.unplaceActivity(act2.id);
              engine.unplaceActivity(act3.id);

              const r1 = engine.getConflictsForSlot(act1, s2);
              const r2 = engine.getConflictsForSlot(act2, s3);
              const r3 = engine.getConflictsForSlot(act3, single.slot);

              if(r1.possible && r1.conflicts.length === 0 &&
                 r2.possible && r2.conflicts.length === 0 &&
                 r3.possible && r3.conflicts.length === 0){
                engine.placeActivityDirect(act1.id, s2);
                engine.placeActivityDirect(act2.id, s3);
                engine.placeActivityDirect(act3.id, single.slot);

                if(engine.isLessonBlockSafe(act1, act2, act3)){
                  const newM = engine.evaluateMetrics();
                  if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                    bestM = { ...newM };
                    roundImproved = true;
                    resolved = true;
                    console.log(`[${Date.now() - t0}ms] 3-way cycle: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                    break;
                  }
                }
                engine.unplaceActivity(act1.id);
                engine.unplaceActivity(act2.id);
                engine.unplaceActivity(act3.id);
              }
              engine.placeActivityDirect(act1.id, single.slot);
              engine.placeActivityDirect(act2.id, s2);
              engine.placeActivityDirect(act3.id, s3);
            }
            if(resolved) break;
          }
        }
        if(resolved) break;
      }
    }

    // STRATEGY 2: INBOUND REINFORCE (Pull lesson from 3+ period session into single session)
    const singletons2 = findSingletons(engine);
    for(const single of singletons2){
      const tGrid = engine.teacherGrid.get(single.gv);
      if(!tGrid) continue;

      // Find sessions where this teacher has >= 3 periods
      const richSessions = [];
      for(let d = 0; d < 6; d++){
        for(let b = 0; b < 2; b++){
          if(d === single.day && b === single.session) continue;
          const sStart = d * 10 + b * 5;
          const taught = [];
          for(let p = 0; p < 5; p++){
            const s = sStart + p;
            if(tGrid[s] >= 0){
              const act = engine.activities[tGrid[s]];
              if(act && !act.isFixed && act.duration === 1){
                taught.push({ slot: s, actId: tGrid[s] });
              }
            }
          }
          if(taught.length >= 3){
            richSessions.push({ day: d, session: b, sStart, taught });
          }
        }
      }

      let reinResolved = false;

      for(const rich of richSessions){
        for(const item of rich.taught){
          const actToPull = engine.activities[item.actId];
          if(!actToPull) continue;
          const pullClassGrid = engine.classGrid.get(actToPull.classId);
          if(!pullClassGrid) continue;

          // Try to place actToPull in single's session
          const singleStart = single.day * 10 + single.session * 5;
          for(let p = 0; p < 5; p++){
            const sTarget = singleStart + p;
            if(sTarget === single.slot) continue;
            if(engine.offSlots.has(`${actToPull.classId}|${sTarget}`)) continue;
            if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

            const existingActId = pullClassGrid[sTarget];

            if(existingActId < 0){
              // Empty slot in pull class
              engine.unplaceActivity(actToPull.id);
              const r1 = engine.getConflictsForSlot(actToPull, sTarget);
              if(r1.possible && r1.conflicts.length === 0){
                engine.placeActivityDirect(actToPull.id, sTarget);
                if(engine.isLessonBlockSafe(actToPull)){
                  const newM = engine.evaluateMetrics();
                  if(newM.soBuoiDay1 < bestM.soBuoiDay1){
                    bestM = { ...newM };
                    roundImproved = true;
                    reinResolved = true;
                    console.log(`[${Date.now() - t0}ms] Inbound pull to empty slot: singletons -> ${bestM.soBuoiDay1}`);
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
                    const newM = engine.evaluateMetrics();
                    if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                      bestM = { ...newM };
                      roundImproved = true;
                      reinResolved = true;
                      console.log(`[${Date.now() - t0}ms] Inbound 2-way swap: singletons -> ${bestM.soBuoiDay1}`);
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

    if(!roundImproved && round > 10) break;
  }

  console.log(`\nUltimate Optimizer finished in ${Date.now() - t0}ms:`, bestM);
  return bestM;
}

runUltimateOptimizer(opt);
