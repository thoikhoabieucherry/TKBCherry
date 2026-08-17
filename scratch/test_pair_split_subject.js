const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
const engineSource = fs.readFileSync(ENGINE_PATH, "utf8");
eval(engineSource);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("Initial Metrics:", JSON.stringify(engine.evaluateMetrics()));

// Let's implement the exact operator logic:
function tryPairSplitSubjectSingletons(engine, currentBest) {
  let anyImproved = false;
  const DAYS = 6, SESSIONS = 2, PERIODS = 5;

  engine.teacherGrid.forEach((tGrid, tKey) => {
    if(!tKey || !engine.isScoredTeacher(tKey)) return;

    // Find all 1-period singleton sessions of this teacher
    const singletonActs = [];
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
          }
        }
        if(taught.length === 1){
          singletonActs.push({ slot: taught[0].slot, actId: taught[0].actId, d, b });
        }
      }
    }

    if(singletonActs.length === 0) return;

    for(const itemB of singletonActs){
      const actB = engine.activities[itemB.actId];
      if(!actB) continue;

      // Find another activity actA of the SAME class and subject taught by this teacher
      const sameSubjectActs = engine.activities.filter(a =>
        a.id !== actB.id && a.gv === tKey && a.classId === actB.classId && a.mon === actB.mon && a.duration === 1 && !a.isFixed
      );

      for(const actA of sameSubjectActs){
        const sA = engine.actPlacement[actA.id];
        const sB = itemB.slot;
        if(sA < 0) continue;

        const cId = actA.classId;
        const cGrid = engine.classGrid.get(cId);
        if(!cGrid) continue;

        let resolved = false;

        // Candidate target sessions (d2, b2) where teacher is completely free (or has compatible slots)
        for(let d2 = 0; d2 < DAYS; d2++){
          for(let b2 = 0; b2 < SESSIONS; b2++){
            const sStart2 = d2 * 10 + b2 * 5;
            if(sStart2 === Math.floor(sA / 5) * 5 || sStart2 === Math.floor(sB / 5) * 5) continue;

            // Find free slots of this class
            const freeClassSlots = [];
            for(let sf = 0; sf < 60; sf++){
              if(sf !== sA && sf !== sB && !engine.offSlots.has(`${cId}|${sf}`) && (cGrid[sf] < 0 && cGrid[sf] !== -3)){
                freeClassSlots.push(sf);
              }
            }
            const candidateDests = [sA, sB, ...freeClassSlots];

            for(let p1 = 0; p1 < PERIODS; p1++){
              for(let p2 = p1 + 1; p2 < PERIODS; p2++){
                const s1 = sStart2 + p1;
                const s2 = sStart2 + p2;
                if(engine.offSlots.has(`${cId}|${s1}`) || engine.offSlots.has(`${cId}|${s2}`)) continue;
                if((tGrid[s1] >= 0 && tGrid[s1] !== actA.id && tGrid[s1] !== actB.id) || tGrid[s1] === -3) continue;
                if((tGrid[s2] >= 0 && tGrid[s2] !== actA.id && tGrid[s2] !== actB.id) || tGrid[s2] === -3) continue;

                const actIdC = cGrid[s1];
                const actIdD = cGrid[s2];
                const actC = actIdC >= 0 ? engine.activities[actIdC] : null;
                const actD = actIdD >= 0 ? engine.activities[actIdD] : null;
                if(actC && (actC.isFixed || actC.duration !== 1)) continue;
                if(actD && (actD.isFixed || actD.duration !== 1)) continue;

                const tGridC = actC ? engine.teacherGrid.get(actC.gv) : null;
                const tGridD = actD ? engine.teacherGrid.get(actD.gv) : null;

                const destsForC = actC ? candidateDests.filter(d => d !== s1 && d !== s2 && tGridC && (tGridC[d] < 0 || tGridC[d] === actA.id || tGridC[d] === actB.id) && tGridC[d] !== -3) : [s1];
                const destsForD = actD ? candidateDests.filter(d => d !== s1 && d !== s2 && tGridD && (tGridD[d] < 0 || tGridD[d] === actA.id || tGridD[d] === actB.id) && tGridD[d] !== -3) : [s2];

                if(destsForC.length === 0 || destsForD.length === 0) continue;

                for(const destC of destsForC){
                  for(const destD of destsForD){
                    if(actC && actD && destC === destD) continue;

                    engine.unplaceActivity(actA.id);
                    engine.unplaceActivity(actB.id);
                    if(actC) engine.unplaceActivity(actC.id);
                    if(actD) engine.unplaceActivity(actD.id);

                    const rA = engine.getConflictsForSlot(actA, s1);
                    const rB = engine.getConflictsForSlot(actB, s2);
                    const rC = actC ? engine.getConflictsForSlot(actC, destC) : { possible: true, conflicts: [] };
                    const rD = actD ? engine.getConflictsForSlot(actD, destD) : { possible: true, conflicts: [] };

                    if(rA.possible && rA.conflicts.length === 0 &&
                       rB.possible && rB.conflicts.length === 0 &&
                       rC.possible && rC.conflicts.length === 0 &&
                       rD.possible && rD.conflicts.length === 0){

                      engine.placeActivityDirect(actA.id, s1);
                      engine.placeActivityDirect(actB.id, s2);
                      if(actC) engine.placeActivityDirect(actC.id, destC);
                      if(actD) engine.placeActivityDirect(actD.id, destD);

                      const safeBlock = engine.isLessonBlockSafe(actA, actB) &&
                        (!actC || engine.isLessonBlockSafe(actC)) &&
                        (!actD || engine.isLessonBlockSafe(actD));

                      if(safeBlock){
                        const m = engine.evaluateMetrics();
                        if(engine.compareMetrics(m, currentBest, "optimize_singletons") < 0){
                          currentBest = { ...m };
                          anyImproved = true;
                          resolved = true;
                          console.log(` -> SUCCESS for ${tKey} (${actA.classId} ${actA.mon}): New Metrics:`, JSON.stringify(m));
                          break;
                        }
                      }
                      engine.unplaceActivity(actA.id);
                      engine.unplaceActivity(actB.id);
                      if(actC) engine.unplaceActivity(actC.id);
                      if(actD) engine.unplaceActivity(actD.id);
                    }

                    engine.placeActivityDirect(actA.id, sA);
                    engine.placeActivityDirect(actB.id, sB);
                    if(actC) engine.placeActivityDirect(actC.id, s1);
                    if(actD) engine.placeActivityDirect(actD.id, s2);
                  }
                  if(resolved) break;
                }
                if(resolved) break;
              }
              if(resolved) break;
            }
            if(resolved) break;
          }
          if(resolved) break;
        }
      }
    }
  });

  return anyImproved ? currentBest : null;
}

let m = engine.evaluateMetrics();
console.log("Running tryConsolidateTeacherSingletons first:");
const r1 = engine.tryConsolidateTeacherSingletons(m, m);
if(r1) m = r1;

console.log("Running tryPairSplitSubjectSingletons:");
const r2 = tryPairSplitSubjectSingletons(engine, m);
if(r2) m = r2;

console.log("\n=== FINAL METRICS ===");
console.log(JSON.stringify(m));

