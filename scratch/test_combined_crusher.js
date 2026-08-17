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

function runCombinedCrusher(engine, maxTimeMs = 15000){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();
  console.log(`Starting Combined Crusher with ${bestM.soBuoiDay1} singletons...`);

  let prevBest = Infinity;

  while(bestM.soBuoiDay1 > 2 && (Date.now() - t0 < maxTimeMs)){
    if(bestM.soBuoiDay1 === prevBest){
      // Try a random 2-way perturbation among duration=1 activities to escape local minimum
      for(let perturb = 0; perturb < 20; perturb++){
        const cids = Array.from(engine.classGrid.keys());
        const cid = cids[Math.floor(Math.random() * cids.length)];
        const cGrid = engine.classGrid.get(cid);
        const s1 = Math.floor(Math.random() * 60);
        const s2 = Math.floor(Math.random() * 60);
        if(s1 === s2 || engine.offSlots.has(`${cid}|${s1}`) || engine.offSlots.has(`${cid}|${s2}`)) continue;
        const a1 = cGrid[s1] >= 0 ? engine.activities[cGrid[s1]] : null;
        const a2 = cGrid[s2] >= 0 ? engine.activities[cGrid[s2]] : null;
        if(a1 && (a1.isFixed || a1.duration !== 1)) continue;
        if(a2 && (a2.isFixed || a2.duration !== 1)) continue;

        if(a1) engine.unplaceActivity(a1.id);
        if(a2) engine.unplaceActivity(a2.id);

        let ok = true;
        if(a1 && (!engine.getConflictsForSlot(a1, s2).possible || engine.getConflictsForSlot(a1, s2).conflicts.length > 0)) ok = false;
        if(a2 && (!engine.getConflictsForSlot(a2, s1).possible || engine.getConflictsForSlot(a2, s1).conflicts.length > 0)) ok = false;

        if(ok){
          if(a1) engine.placeActivityDirect(a1.id, s2);
          if(a2) engine.placeActivityDirect(a2.id, s1);
          if(engine.isLessonBlockSafe(a1, a2)){
            const m = engine.evaluateMetrics();
            if(m.soBuoiDay1 <= bestM.soBuoiDay1 + 2){ // Accept slight neutral perturbation
              break;
            }
          }
          if(a1) engine.unplaceActivity(a1.id);
          if(a2) engine.unplaceActivity(a2.id);
        }
        if(a1) engine.placeActivityDirect(a1.id, s1);
        if(a2) engine.placeActivityDirect(a2.id, s2);
      }
    }

    prevBest = bestM.soBuoiDay1;

    // PASS 1: Outbound Cycles (2-way and 3-way)
    const singletons = findSingletons(engine);
    engine.rng.shuffle(singletons);

    for(const single of singletons){
      const act1 = engine.activities[single.actId];
      if(!act1 || act1.duration !== 1) continue;
      const cGrid = engine.classGrid.get(act1.classId);
      const tGrid = engine.teacherGrid.get(single.gv);
      if(!cGrid || !tGrid) continue;

      const targetSessions = [];
      for(let d = 0; d < 6; d++){
        for(let b = 0; b < 2; b++){
          if(d === single.day && b === single.session) continue;
          const sStart = d * 10 + b * 5;
          let cnt = 0;
          for(let p = 0; p < 5; p++){
            if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) cnt++;
          }
          targetSessions.push({ day: d, session: b, sStart, cnt });
        }
      }
      targetSessions.sort((a, b) => b.cnt - a.cnt);

      let resolved = false;

      for(const sess of targetSessions){
        for(let p = 0; p < 5; p++){
          const s2 = sess.sStart + p;
          if(engine.offSlots.has(`${act1.classId}|${s2}`)) continue;
          if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue;

          const actId2 = cGrid[s2];

          if(actId2 < 0){
            engine.unplaceActivity(act1.id);
            const r1 = engine.getConflictsForSlot(act1, s2);
            if(r1.possible && r1.conflicts.length === 0){
              engine.placeActivityDirect(act1.id, s2);
              if(engine.isLessonBlockSafe(act1)){
                const newM = engine.evaluateMetrics();
                if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                  bestM = { ...newM };
                  resolved = true;
                  console.log(`[${Date.now() - t0}ms] Empty slot move: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                  break;
                }
              }
              engine.unplaceActivity(act1.id);
            }
            engine.placeActivityDirect(act1.id, single.slot);
            continue;
          }

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

          // 3-way Cycle
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
  }

  console.log(`\nCombined Crusher finished in ${Date.now() - t0}ms:`, bestM);
}

runCombinedCrusher(opt);
