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

// First run the 1.3s lightning crusher
const testScript = fs.readFileSync('scratch/test_lightning_singleton_optimizer.js', 'utf8');
eval(testScript.replace('optimizeSingletonsLightning(opt, 5000);', ''));
optimizeSingletonsLightning(opt, 3000);

console.log("Metrics after lightning:", opt.evaluateMetrics());

// Now let's implement the Augmenting Path Singleton Solver (BFS depth 4 within class / across classes)
function solveTeacherSingletonPairs(engine){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();

  const teachers = Array.from(engine.teacherGrid.keys()).filter(Boolean);

  for(let pass = 0; pass < 20; pass++){
    if(bestM.soBuoiDay1 <= 2) break;
    let passImproved = false;

    for(const gv of teachers){
      const tGrid = engine.teacherGrid.get(gv);
      if(!tGrid) continue;

      // Find all 1-period sessions for gv
      const singletons = [];
      for(let d = 0; d < 6; d++){
        for(let b = 0; b < 2; b++){
          const sStart = d * 10 + b * 5;
          const taught = [];
          for(let p = 0; p < 5; p++){
            const s = sStart + p;
            if(tGrid[s] >= 0){
              const act = engine.activities[tGrid[s]];
              if(act && !act.isFixed && act.duration === 1){
                taught.push({ slot: s, act });
              }
            }else if(tGrid[s] === -3){
              taught.push({ slot: s, act: null });
            }
          }
          if(taught.length === 1 && taught[0].act){
            singletons.push({ day: d, session: b, sStart, item: taught[0] });
          }
        }
      }

      if(singletons.length === 0) continue;

      // Try to merge each singleton into any other session where gv teaches
      for(const single of singletons){
        const actSrc = single.item.act;
        const cGrid = engine.classGrid.get(actSrc.classId);
        if(!cGrid) continue;

        // Target sessions for gv
        const targetSessions = [];
        for(let d = 0; d < 6; d++){
          for(let b = 0; b < 2; b++){
            if(d === single.day && b === single.session) continue;
            const sStart = d * 10 + b * 5;
            let cnt = 0;
            for(let p = 0; p < 5; p++){
              if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) cnt++;
            }
            if(cnt >= 1 && cnt < 5){
              targetSessions.push({ sStart, cnt });
            }
          }
        }
        targetSessions.sort((a, b) => b.cnt - a.cnt);

        let merged = false;

        for(const tgt of targetSessions){
          for(let p = 0; p < 5; p++){
            const sTarget = tgt.sStart + p;
            if(engine.offSlots.has(`${actSrc.classId}|${sTarget}`)) continue;
            if(tGrid[sTarget] >= 0 || tGrid[sTarget] === -3) continue;

            const actIdDst = cGrid[sTarget];

            // 1. Direct empty slot
            if(actIdDst < 0){
              engine.unplaceActivity(actSrc.id);
              if(engine.getConflictsForSlot(actSrc, sTarget).possible && engine.getConflictsForSlot(actSrc, sTarget).conflicts.length === 0){
                engine.placeActivityDirect(actSrc.id, sTarget);
                if(engine.isLessonBlockSafe(actSrc)){
                  const m = engine.evaluateMetrics();
                  if(m.soBuoiDay1 < bestM.soBuoiDay1){
                    bestM = { ...m };
                    passImproved = true;
                    merged = true;
                    console.log(`[Augmenting Path] Singletons -> ${bestM.soBuoiDay1} (Empty slot)`);
                    break;
                  }
                }
                engine.unplaceActivity(actSrc.id);
              }
              engine.placeActivityDirect(actSrc.id, single.item.slot);
              continue;
            }

            // 2. 2-way swap
            const actDst = engine.activities[actIdDst];
            if(!actDst || actDst.isFixed || actDst.duration !== 1) continue;

            const tDstGrid = engine.teacherGrid.get(actDst.gv);
            if(tDstGrid && tDstGrid[single.item.slot] < 0 && tDstGrid[single.item.slot] !== -3){
              engine.unplaceActivity(actSrc.id);
              engine.unplaceActivity(actDst.id);

              const r1 = engine.getConflictsForSlot(actSrc, sTarget);
              const r2 = engine.getConflictsForSlot(actDst, single.item.slot);

              if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
                engine.placeActivityDirect(actSrc.id, sTarget);
                engine.placeActivityDirect(actDst.id, single.item.slot);

                if(engine.isLessonBlockSafe(actSrc, actDst)){
                  const m = engine.evaluateMetrics();
                  if(m.soBuoiDay1 < bestM.soBuoiDay1){
                    bestM = { ...m };
                    passImproved = true;
                    merged = true;
                    console.log(`[Augmenting Path] Singletons -> ${bestM.soBuoiDay1} (2-way swap)`);
                    break;
                  }
                }
                engine.unplaceActivity(actSrc.id);
                engine.unplaceActivity(actDst.id);
              }
              engine.placeActivityDirect(actSrc.id, single.item.slot);
              engine.placeActivityDirect(actDst.id, sTarget);
            }
            if(merged) break;

            // 3. 4-way BFS Augmenting Path in Class C:
            // Swap chain: actSrc @ s1 -> sTarget (holds actDst). actDst -> s3 (holds act3). act3 -> s4 (holds act4). act4 -> s1!
            for(let s3 = 0; s3 < 60; s3++){
              if(s3 === single.item.slot || s3 === sTarget || engine.offSlots.has(`${actSrc.classId}|${s3}`)) continue;
              const actId3 = cGrid[s3];
              if(actId3 < 0) continue;
              const act3 = engine.activities[actId3];
              if(!act3 || act3.isFixed || act3.duration !== 1) continue;

              for(let s4 = 0; s4 < 60; s4++){
                if(s4 === single.item.slot || s4 === sTarget || s4 === s3 || engine.offSlots.has(`${actSrc.classId}|${s4}`)) continue;
                const actId4 = cGrid[s4];
                if(actId4 < 0) continue;
                const act4 = engine.activities[actId4];
                if(!act4 || act4.isFixed || act4.duration !== 1) continue;

                engine.unplaceActivity(actSrc.id);
                engine.unplaceActivity(actDst.id);
                engine.unplaceActivity(act3.id);
                engine.unplaceActivity(act4.id);

                const r1 = engine.getConflictsForSlot(actSrc, sTarget);
                const r2 = engine.getConflictsForSlot(actDst, s3);
                const r3 = engine.getConflictsForSlot(act3, s4);
                const r4 = engine.getConflictsForSlot(act4, single.item.slot);

                if(r1.possible && r1.conflicts.length === 0 &&
                   r2.possible && r2.conflicts.length === 0 &&
                   r3.possible && r3.conflicts.length === 0 &&
                   r4.possible && r4.conflicts.length === 0){
                  engine.placeActivityDirect(actSrc.id, sTarget);
                  engine.placeActivityDirect(actDst.id, s3);
                  engine.placeActivityDirect(act3.id, s4);
                  engine.placeActivityDirect(act4.id, single.item.slot);

                  if(engine.isLessonBlockSafe(actSrc, actDst, act3, act4)){
                    const m = engine.evaluateMetrics();
                    if(m.soBuoiDay1 < bestM.soBuoiDay1){
                      bestM = { ...m };
                      passImproved = true;
                      merged = true;
                      console.log(`[Augmenting Path] Singletons -> ${bestM.soBuoiDay1} (4-way cycle in class)`);
                      break;
                    }
                  }
                  engine.unplaceActivity(actSrc.id);
                  engine.unplaceActivity(actDst.id);
                  engine.unplaceActivity(act3.id);
                  engine.unplaceActivity(act4.id);
                }
                engine.placeActivityDirect(actSrc.id, single.item.slot);
                engine.placeActivityDirect(actDst.id, sTarget);
                engine.placeActivityDirect(act3.id, s3);
                engine.placeActivityDirect(act4.id, s4);
              }
              if(merged) break;
            }
            if(merged) break;
          }
          if(merged) break;
        }
      }
    }
    if(!passImproved) break;
  }

  console.log(`Finished in ${Date.now() - t0}ms:`, bestM);
  return bestM;
}

solveTeacherSingletonPairs(opt);
