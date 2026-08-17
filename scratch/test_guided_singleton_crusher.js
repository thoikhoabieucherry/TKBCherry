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

// Guided Singleton Crusher
function findSingletonTeachers(engine){
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

const t0 = Date.now();
let bestM = opt.evaluateMetrics();
console.log(`Starting Guided Crusher with ${bestM.soBuoiDay1} singletons...`);

for(let iter = 0; iter < 100; iter++){
  const singletons = findSingletonTeachers(opt);
  if(singletons.length <= 2) break;

  let anyImproved = false;
  opt.rng.shuffle(singletons);

  for(const single of singletons){
    const act1 = opt.activities[single.actId];
    if(!act1 || act1.duration !== 1) continue;

    const cGrid = opt.classGrid.get(act1.classId);
    if(!cGrid) continue;
    const tGrid = opt.teacherGrid.get(single.gv);
    if(!tGrid) continue;

    // Find candidate sessions for teacher single.gv:
    // Prefer sessions where teacher already teaches >= 1 periods!
    const targetSessions = [];
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        if(d === single.day && b === single.session) continue;
        const sStart = d * 10 + b * 5;
        let tCount = 0;
        for(let p = 0; p < 5; p++){
          if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) tCount++;
        }
        if(tCount >= 1 && tCount < 5){
          targetSessions.push({ day: d, session: b, sStart, tCount, priority: 1 });
        }
      }
    }

    targetSessions.sort((a, b) => b.tCount - a.tCount);

    let resolved = false;

    for(const sess of targetSessions){
      for(let p = 0; p < 5; p++){
        const s2 = sess.sStart + p;
        if(opt.offSlots.has(`${act1.classId}|${s2}`)) continue;
        if(tGrid[s2] >= 0 || tGrid[s2] === -3) continue; // Teacher already busy here

        const actId2 = cGrid[s2];

        // Case 1: Slot s2 is empty in class
        if(actId2 < 0){
          opt.unplaceActivity(act1.id);
          const r1 = opt.getConflictsForSlot(act1, s2);
          if(r1.possible && r1.conflicts.length === 0){
            opt.placeActivityDirect(act1.id, s2);
            if(opt.isLessonBlockSafe(act1)){
              const newM = opt.evaluateMetrics();
              if(newM.soBuoiDay1 < bestM.soBuoiDay1){
                bestM = { ...newM };
                anyImproved = true;
                resolved = true;
                console.log(`[${Date.now() - t0}ms] Empty-slot move: singletons -> ${bestM.soBuoiDay1}`);
                break;
              }
            }
            opt.unplaceActivity(act1.id);
          }
          opt.placeActivityDirect(act1.id, single.slot);
          continue;
        }

        // Case 2: Slot s2 has act2 (duration = 1)
        const act2 = opt.activities[actId2];
        if(!act2 || act2.isFixed || act2.duration !== 1) continue;

        const tGrid2 = opt.teacherGrid.get(act2.gv);

        // 2A. Direct 2-way swap: act1 -> s2, act2 -> single.slot
        if(tGrid2 && (tGrid2[single.slot] < 0 && tGrid2[single.slot] !== -3)){
          opt.unplaceActivity(act1.id);
          opt.unplaceActivity(act2.id);

          const r1 = opt.getConflictsForSlot(act1, s2);
          const r2 = opt.getConflictsForSlot(act2, single.slot);

          if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
            opt.placeActivityDirect(act1.id, s2);
            opt.placeActivityDirect(act2.id, single.slot);

            if(opt.isLessonBlockSafe(act1, act2)){
              const newM = opt.evaluateMetrics();
              // Accept if strictly better, or equal singletons with fewer sessions
              if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                bestM = { ...newM };
                anyImproved = true;
                resolved = true;
                console.log(`[${Date.now() - t0}ms] Direct 2-way swap: singletons -> ${bestM.soBuoiDay1} (sessions: ${bestM.tsBuoiDay})`);
                break;
              }
            }
            opt.unplaceActivity(act1.id);
            opt.unplaceActivity(act2.id);
          }
          opt.placeActivityDirect(act1.id, single.slot);
          opt.placeActivityDirect(act2.id, s2);
        }
        if(resolved) break;

        // 2B. 3-way Cyclic swap inside class: act1 -> s2, act2 -> s3, act3 -> single.slot
        for(let s3 = 0; s3 < 60; s3++){
          if(s3 === single.slot || s3 === s2) continue;
          if(opt.offSlots.has(`${act1.classId}|${s3}`)) continue;
          const actId3 = cGrid[s3];
          if(actId3 < 0){
            // act1 -> s2, act2 -> s3 (empty)
            opt.unplaceActivity(act1.id);
            opt.unplaceActivity(act2.id);

            const r1 = opt.getConflictsForSlot(act1, s2);
            const r2 = opt.getConflictsForSlot(act2, s3);

            if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
              opt.placeActivityDirect(act1.id, s2);
              opt.placeActivityDirect(act2.id, s3);

              if(opt.isLessonBlockSafe(act1, act2)){
                const newM = opt.evaluateMetrics();
                if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                  bestM = { ...newM };
                  anyImproved = true;
                  resolved = true;
                  console.log(`[${Date.now() - t0}ms] 2-hop into empty s3: singletons -> ${bestM.soBuoiDay1}`);
                  break;
                }
              }
              opt.unplaceActivity(act1.id);
              opt.unplaceActivity(act2.id);
            }
            opt.placeActivityDirect(act1.id, single.slot);
            opt.placeActivityDirect(act2.id, s2);
          }else{
            const act3 = opt.activities[actId3];
            if(!act3 || act3.isFixed || act3.duration !== 1) continue;

            opt.unplaceActivity(act1.id);
            opt.unplaceActivity(act2.id);
            opt.unplaceActivity(act3.id);

            const r1 = opt.getConflictsForSlot(act1, s2);
            const r2 = opt.getConflictsForSlot(act2, s3);
            const r3 = opt.getConflictsForSlot(act3, single.slot);

            if(r1.possible && r1.conflicts.length === 0 &&
               r2.possible && r2.conflicts.length === 0 &&
               r3.possible && r3.conflicts.length === 0){
              opt.placeActivityDirect(act1.id, s2);
              opt.placeActivityDirect(act2.id, s3);
              opt.placeActivityDirect(act3.id, single.slot);

              if(opt.isLessonBlockSafe(act1, act2, act3)){
                const newM = opt.evaluateMetrics();
                if(newM.soBuoiDay1 < bestM.soBuoiDay1 || (newM.soBuoiDay1 === bestM.soBuoiDay1 && newM.tsBuoiDay < bestM.tsBuoiDay)){
                  bestM = { ...newM };
                  anyImproved = true;
                  resolved = true;
                  console.log(`[${Date.now() - t0}ms] 3-way cycle: singletons -> ${bestM.soBuoiDay1}`);
                  break;
                }
              }
              opt.unplaceActivity(act1.id);
              opt.unplaceActivity(act2.id);
              opt.unplaceActivity(act3.id);
            }
            opt.placeActivityDirect(act1.id, single.slot);
            opt.placeActivityDirect(act2.id, s2);
            opt.placeActivityDirect(act3.id, s3);
          }
          if(resolved) break;
        }
      }
      if(resolved) break;
    }
  }

  if(!anyImproved) break;
}

console.log(`\nFinal result in ${Date.now() - t0}ms:`, bestM);
