const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

// Test 3-way cycle repair algorithm
function test3WayCycleRepair(solver){
  const DAYS = 6;
  const SESSIONS = 2;
  const PERIODS = 5;
  const SLOTS_PER_DAY = 10;

  let currentBest = solver.evaluateMetrics();
  console.log("Starting 3-way cycle repair with singletons:", currentBest.soBuoiDay1);

  let anyImproved = false;
  const maxPasses = 15;

  for(let pass = 0; pass < maxPasses; pass++){
    if(currentBest.soBuoiDay1 === 0) break;
    let passImproved = false;

    // Collect singletons
    const singletons = [];
    solver.teacherGrid.forEach((grid, tKey) => {
      if(!tKey || !solver.isScoredTeacher(tKey)) return;
      for(let d = 0; d < DAYS; d++){
        for(let b = 0; b < SESSIONS; b++){
          const sStart = d * SLOTS_PER_DAY + b * PERIODS;
          const taught = [];
          for(let p = 0; p < PERIODS; p++){
            const s = sStart + p;
            const actId = grid[s];
            if(actId >= 0){
              const act = solver.activities[actId];
              if(act && !act.isFixed && act.duration === 1){
                taught.push({ slot: s, actId, p, act });
              }
            }else if(actId === -3){
              taught.push({ slot: s, actId: -3, p, act: null });
            }
          }
          if(taught.length === 1 && taught[0].actId >= 0){
            singletons.push({
              teacher: tKey,
              day: d,
              session: b,
              sStart,
              slot: taught[0].slot,
              actId: taught[0].actId,
              act: taught[0].act
            });
          }
        }
      }
    });

    for(const sing of singletons){
      const t1 = sing.teacher;
      const act1 = sing.act;
      const s1 = sing.slot;
      const cGrid1 = solver.classGrid.get(act1.classId);
      const tGrid1 = solver.teacherGrid.get(t1);
      if(!cGrid1 || !tGrid1) continue;

      // Find candidate sessions for t1 (Move-out)
      const candSessions = [];
      for(let d2 = 0; d2 < DAYS; d2++){
        if(d2 === sing.day) continue;
        const sStart2 = d2 * SLOTS_PER_DAY + sing.session * PERIODS;
        let cnt = 0;
        for(let p2 = 0; p2 < PERIODS; p2++){
          if(tGrid1[sStart2 + p2] >= 0 || tGrid1[sStart2 + p2] === -3) cnt++;
        }
        if(cnt >= 1 && cnt < 5){
          candSessions.push({ sStart: sStart2, count: cnt });
        }
      }

      let bestCycle = null;

      for(const tgt of candSessions){
        for(let p2 = 0; p2 < PERIODS; p2++){
          const s2 = tgt.sStart + p2;
          if(s2 === s1 || tGrid1[s2] >= 0 || tGrid1[s2] === -3) continue;

          // Slot s2 in class 1 is occupied by act2 (teacher t2)
          const act2Id = cGrid1[s2];
          if(act2Id < 0) continue;
          const act2 = solver.activities[act2Id];
          if(!act2 || act2.isFixed || act2.duration !== 1 || act2.teacherId === t1) continue;
          const t2 = act2.teacherId;
          const tGrid2 = solver.teacherGrid.get(t2);
          if(!tGrid2) continue;

          // If t2 cannot go to s1 (i.e. 2-way blocked), search for 3rd activity act3 (class 3 or class 2)
          // 3-way cycle: act1: s1 -> s2, act2: s2 -> s3, act3: s3 -> s1
          // Requirements:
          // 1. act1 (class 1) goes to s2: class 1 free at s2 (since act2 moves), t1 free at s2.
          // 2. act2 (class 1) goes to s3: class 1 (or act2's class) free at s3, t2 free at s3.
          // 3. act3 (class 3) goes to s1: class 3 free at s1, t3 free at s1.
          
          // Case: act2 and act3 in same class 1: act1: s1 -> s2, act2: s2 -> s3, act3: s3 -> s1 (3-way swap in class 1)
          for(let s3 = 0; s3 < 60; s3++){
            if(s3 === s1 || s3 === s2) continue;
            // Check if s3 in class 1 has act3
            const act3Id = cGrid1[s3];
            if(act3Id < 0) continue;
            const act3 = solver.activities[act3Id];
            if(!act3 || act3.isFixed || act3.duration !== 1 || act3.teacherId === t1 || act3.teacherId === t2) continue;
            const t3 = act3.teacherId;
            const tGrid3 = solver.teacherGrid.get(t3);
            if(!tGrid3) continue;

            // Check if t2 free at s3 and t3 free at s1
            if(tGrid2[s3] >= 0 || tGrid2[s3] === -3) continue;
            if(tGrid3[s1] >= 0 || tGrid3[s1] === -3) continue;

            // Evaluate 3-cycle in class 1: act1 -> s2, act2 -> s3, act3 -> s1
            const jrnMark = solver.moveJournal.length;
            solver.jrnUnplace(act1.id);
            solver.jrnUnplace(act2.id);
            solver.jrnUnplace(act3.id);

            const conf1 = solver.getConflictsForSlot(act1, s2);
            const conf2 = solver.getConflictsForSlot(act2, s3);
            const conf3 = solver.getConflictsForSlot(act3, s1);

            if(conf1.possible && conf1.conflicts.length === 0 &&
               conf2.possible && conf2.conflicts.length === 0 &&
               conf3.possible && conf3.conflicts.length === 0){
              solver.jrnPlace(act1.id, s2);
              solver.jrnPlace(act2.id, s3);
              solver.jrnPlace(act3.id, s1);

              if(solver.isLessonBlockSafe(act1, act2, act3) && solver.countStudentHoles() === 0){
                const candM = solver.evaluateMetrics();
                const isBetter = (candM.soBuoiDay1 < currentBest.soBuoiDay1) &&
                                 (candM.soBuoiTrong2 <= currentBest.soBuoiTrong2) &&
                                 (candM.soNgayMotTiet <= currentBest.soNgayMotTiet);
                if(isBetter){
                  if(!bestCycle || solver.compareMetrics(candM, bestCycle.metrics, "optimize_singletons") < 0){
                    bestCycle = {
                      moves: [
                        { act: act1, to: s2 },
                        { act: act2, to: s3 },
                        { act: act3, to: s1 }
                      ],
                      metrics: { ...candM }
                    };
                  }
                }
              }
            }
            solver.jrnRollback(jrnMark);
          }
        }
      }

      if(bestCycle){
        for(const m of bestCycle.moves){
          solver.jrnUnplace(m.act.id);
        }
        for(const m of bestCycle.moves){
          solver.jrnPlace(m.act.id, m.to);
        }
        currentBest = solver.evaluateMetrics();
        console.log(`  [Pass ${pass+1}] 3-Way Cycle accepted: singletons = ${currentBest.soBuoiDay1}`);
        passImproved = true;
        anyImproved = true;
        break;
      }
    }
    if(!passImproved) break;
  }

  console.log("3-Way Cycle repair final metrics:", currentBest);
  return currentBest;
}

const solver = new FetTimetableEngine(schoolData);
solver.loadExistingSchedule();
console.log("Baseline metrics:", solver.evaluateMetrics());
solver.tryFastSingletonRepair();
console.log("After 2-way fast repair:", solver.evaluateMetrics());
test3WayCycleRepair(solver);
