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

// Cross-Class Ejection Chain Algorithm (BFS Depth 3)
// For a singleton activity act1 at slot s1:
// Find paths: (act1 @ s1 in C1) -> (act2 @ s2 in C1) -> if act2 blocked by act3 @ s1 in C2 -> (act3 @ s1 in C2) -> (act4 @ s_k in C2)...
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

function runCrossClassEjectionOptimizer(engine, maxTimeMs = 30000){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();
  console.log(`Starting Cross-Class Ejection Optimizer with ${bestM.soBuoiDay1} singletons...`);

  for(let iter = 0; iter < 100; iter++){
    if(bestM.soBuoiDay1 <= 2) break;
    if(Date.now() - t0 > maxTimeMs) break;

    let improved = false;
    const singletons = findSingletons(engine);
    engine.rng.shuffle(singletons);

    for(const single of singletons){
      const act1 = engine.activities[single.actId];
      if(!act1 || act1.duration !== 1) continue;
      const c1Grid = engine.classGrid.get(act1.classId);
      const t1Grid = engine.teacherGrid.get(single.gv);
      if(!c1Grid || !t1Grid) continue;

      // Try target sessions for act1
      const targetSessions = [];
      for(let d = 0; d < 6; d++){
        for(let b = 0; b < 2; b++){
          if(d === single.day && b === single.session) continue;
          const sStart = d * 10 + b * 5;
          let cnt = 0;
          for(let p = 0; p < 5; p++){
            if(t1Grid[sStart + p] >= 0 || t1Grid[sStart + p] === -3) cnt++;
          }
          targetSessions.push({ day: d, session: b, sStart, cnt });
        }
      }
      targetSessions.sort((a, b) => b.cnt - a.cnt);

      let chainSuccess = false;

      for(const sess of targetSessions){
        for(let p2 = 0; p2 < 5; p2++){
          const s2 = sess.sStart + p2;
          if(engine.offSlots.has(`${act1.classId}|${s2}`)) continue;
          if(t1Grid[s2] >= 0 || t1Grid[s2] === -3) continue;

          const actId2 = c1Grid[s2];
          if(actId2 < 0) continue; // Handled by simple pass

          const act2 = engine.activities[actId2];
          if(!act2 || act2.isFixed || act2.duration !== 1) continue;

          const t2Grid = engine.teacherGrid.get(act2.gv);
          if(!t2Grid) continue;

          // If t2 is busy at single.slot (s1), find which class t2 is teaching at s1!
          if(t2Grid[single.slot] >= 0){
            const actId3 = t2Grid[single.slot];
            const act3 = engine.activities[actId3];
            if(act3 && !act3.isFixed && act3.duration === 1 && act3.classId !== act1.classId){
              // act3 is in class C2 at slot s1!
              const c2Grid = engine.classGrid.get(act3.classId);
              if(!c2Grid) continue;

              // In class C2, can act3 move to s2 or another slot s4?
              for(let s4 = 0; s4 < 60; s4++){
                if(s4 === single.slot || s4 === s2) continue;
                if(engine.offSlots.has(`${act3.classId}|${s4}`)) continue;

                const actId4 = c2Grid[s4];
                if(actId4 < 0){
                  // 4-step chain: act1 -> s2 (in C1), act2 -> s1 (in C1 freed by moving act3), act3 -> s4 (in C2)
                  engine.unplaceActivity(act1.id);
                  engine.unplaceActivity(act2.id);
                  engine.unplaceActivity(act3.id);

                  const r1 = engine.getConflictsForSlot(act1, s2);
                  const r2 = engine.getConflictsForSlot(act2, single.slot);
                  const r3 = engine.getConflictsForSlot(act3, s4);

                  if(r1.possible && r1.conflicts.length === 0 &&
                     r2.possible && r2.conflicts.length === 0 &&
                     r3.possible && r3.conflicts.length === 0){
                    engine.placeActivityDirect(act1.id, s2);
                    engine.placeActivityDirect(act2.id, single.slot);
                    engine.placeActivityDirect(act3.id, s4);

                    if(engine.isLessonBlockSafe(act1, act2, act3)){
                      const newM = engine.evaluateMetrics();
                      if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                        bestM = { ...newM };
                        improved = true;
                        chainSuccess = true;
                        console.log(`[${Date.now() - t0}ms] Cross-class 4-way chain: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                        break;
                      }
                    }
                    engine.unplaceActivity(act1.id);
                    engine.unplaceActivity(act2.id);
                    engine.unplaceActivity(act3.id);
                  }
                  engine.placeActivityDirect(act1.id, single.slot);
                  engine.placeActivityDirect(act2.id, s2);
                  engine.placeActivityDirect(act3.id, single.slot);
                }else{
                  const act4 = engine.activities[actId4];
                  if(!act4 || act4.isFixed || act4.duration !== 1) continue;

                  // 4-way cyclic cross-class: act1 -> s2, act2 -> s1, act3 -> s4, act4 -> s2 (in C2)?
                  // try act4 -> s2 (in C2)
                  if(!engine.offSlots.has(`${act4.classId}|${s2}`) && c2Grid[s2] < 0){
                    engine.unplaceActivity(act1.id);
                    engine.unplaceActivity(act2.id);
                    engine.unplaceActivity(act3.id);
                    engine.unplaceActivity(act4.id);

                    const r1 = engine.getConflictsForSlot(act1, s2);
                    const r2 = engine.getConflictsForSlot(act2, single.slot);
                    const r3 = engine.getConflictsForSlot(act3, s4);
                    const r4 = engine.getConflictsForSlot(act4, s2);

                    if(r1.possible && r1.conflicts.length === 0 &&
                       r2.possible && r2.conflicts.length === 0 &&
                       r3.possible && r3.conflicts.length === 0 &&
                       r4.possible && r4.conflicts.length === 0){
                      engine.placeActivityDirect(act1.id, s2);
                      engine.placeActivityDirect(act2.id, single.slot);
                      engine.placeActivityDirect(act3.id, s4);
                      engine.placeActivityDirect(act4.id, s2);

                      if(engine.isLessonBlockSafe(act1, act2, act3, act4)){
                        const newM = engine.evaluateMetrics();
                        if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                          bestM = { ...newM };
                          improved = true;
                          chainSuccess = true;
                          console.log(`[${Date.now() - t0}ms] Cross-class 4-way cyclic: singletons -> ${bestM.soBuoiDay1}`);
                          break;
                        }
                      }
                      engine.unplaceActivity(act1.id);
                      engine.unplaceActivity(act2.id);
                      engine.unplaceActivity(act3.id);
                      engine.unplaceActivity(act4.id);
                    }
                    engine.placeActivityDirect(act1.id, single.slot);
                    engine.placeActivityDirect(act2.id, s2);
                    engine.placeActivityDirect(act3.id, single.slot);
                    engine.placeActivityDirect(act4.id, s4);
                  }
                }
                if(chainSuccess) break;
              }
            }
          }
          if(chainSuccess) break;
        }
        if(chainSuccess) break;
      }
    }

    if(!improved) break;
  }

  console.log(`\nCross-Class Ejection Optimizer finished in ${Date.now() - t0}ms:`, bestM);
}

runCrossClassEjectionOptimizer(opt);
