const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
let engineSource = fs.readFileSync(ENGINE_PATH, "utf8");
eval(engineSource);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const SESSIONS_LIST = ["sang", "chieu"];
const SLOTS_PER_DAY = 10;
const PERIODS_PER_SESSION = 5;

FetTimetableEngine.prototype.tryConsolidatePairSingletons = function(bestMetrics, initialMetrics, maxGap2Limit = Infinity, onProgress = null){
  let currentBest = { ...bestMetrics };
  let anyImproved = false;

  for(let pass = 0; pass < 5; pass++){
    let passImproved = false;

    this.teacherGrid.forEach((tGrid, tKey) => {
      if(!tKey || !this.isScoredTeacher(tKey)) return;
      const tKeyNorm = String(tKey).trim().toLowerCase();

      const singletons = [];
      for(let d = 0; d < DAYS_LIST.length; d++){
        for(let b = 0; b < SESSIONS_LIST.length; b++){
          const sStart = d * SLOTS_PER_DAY + b * PERIODS_PER_SESSION;
          const taught = [];
          for(let p = 0; p < PERIODS_PER_SESSION; p++){
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
          if(taught.length === 1 && taught[0].actId >= 0){
            singletons.push({ slot: taught[0].slot, actId: taught[0].actId, d, b });
          }
        }
      }

      if(singletons.length === 0) return;

      for(const itemB of singletons){
        const actB = this.activities[itemB.actId];
        if(!actB) continue;
        const sB = itemB.slot;
        const cId = actB.classId;
        const cGrid = this.classGrid.get(cId);
        if(!cGrid) continue;

        const partnerActs = this.activities.filter(a =>
          a.id !== actB.id &&
          String(a.gv || "").trim().toLowerCase() === tKeyNorm &&
          a.classId === actB.classId &&
          a.mon === actB.mon &&
          a.duration === 1 &&
          !a.isFixed
        );

        for(const actA of partnerActs){
          const sA = this.actPlacement[actA.id];
          if(sA < 0 || sA === sB) continue;
          const dA = Math.floor(sA / 10);
          const bA = Math.floor((sA % 10) / 5);

          let pairResolved = false;

          for(let d2 = 0; d2 < DAYS_LIST.length; d2++){
            for(let b2 = 0; b2 < SESSIONS_LIST.length; b2++){
              if((d2 === dA && b2 === bA) || (d2 === itemB.d && b2 === itemB.b)) continue;
              const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS_PER_SESSION;

              const freeClassSlots = [];
              for(let sf = 0; sf < 60; sf++){
                if(sf !== sA && sf !== sB && !this.offSlots.has(`${cId}|${sf}`) && (cGrid[sf] < 0 && cGrid[sf] !== -3)){
                  freeClassSlots.push(sf);
                }
              }
              const candidateDests = [sA, sB, ...freeClassSlots];

              for(let p1 = 0; p1 < PERIODS_PER_SESSION; p1++){
                for(let p2 = p1 + 1; p2 < PERIODS_PER_SESSION; p2++){
                  const s1 = sStart2 + p1;
                  const s2 = sStart2 + p2;
                  if(this.offSlots.has(`${cId}|${s1}`) || this.offSlots.has(`${cId}|${s2}`)) continue;
                  if((tGrid[s1] >= 0 && tGrid[s1] !== actA.id && tGrid[s1] !== actB.id) || tGrid[s1] === -3) continue;
                  if((tGrid[s2] >= 0 && tGrid[s2] !== actA.id && tGrid[s2] !== actB.id) || tGrid[s2] === -3) continue;

                  const actIdC = cGrid[s1];
                  const actIdD = cGrid[s2];
                  const actC = actIdC >= 0 ? this.activities[actIdC] : null;
                  const actD = actIdD >= 0 ? this.activities[actIdD] : null;
                  if(actC && (actC.isFixed || actC.duration !== 1)) continue;
                  if(actD && (actD.isFixed || actD.duration !== 1)) continue;

                  const tGridC = actC ? this.teacherGrid.get(String(actC.gv || "").trim().toLowerCase()) : null;
                  const tGridD = actD ? this.teacherGrid.get(String(actD.gv || "").trim().toLowerCase()) : null;

                  const destsForC = actC ? candidateDests.filter(d => d !== s1 && d !== s2 && tGridC && (tGridC[d] < 0 || tGridC[d] === actA.id || tGridC[d] === actB.id) && tGridC[d] !== -3) : [s1];
                  const destsForD = actD ? candidateDests.filter(d => d !== s1 && d !== s2 && tGridD && (tGridD[d] < 0 || tGridD[d] === actA.id || tGridD[d] === actB.id) && tGridD[d] !== -3) : [s2];

                  if(destsForC.length === 0 || destsForD.length === 0) continue;

                  for(const destC of destsForC){
                    for(const destD of destsForD){
                      if(actC && actD && destC === destD) continue;

                      this.unplaceActivity(actA.id);
                      this.unplaceActivity(actB.id);
                      if(actC) this.unplaceActivity(actC.id);
                      if(actD) this.unplaceActivity(actD.id);

                      const rA = this.getConflictsForSlot(actA, s1);
                      const rB = this.getConflictsForSlot(actB, s2);
                      const rC = actC ? this.getConflictsForSlot(actC, destC) : { possible: true, conflicts: [] };
                      const rD = actD ? this.getConflictsForSlot(actD, destD) : { possible: true, conflicts: [] };

                      if(rA.possible && rA.conflicts.length === 0 &&
                         rB.possible && rB.conflicts.length === 0 &&
                         rC.possible && rC.conflicts.length === 0 &&
                         rD.possible && rD.conflicts.length === 0){

                        this.placeActivityDirect(actA.id, s1);
                        this.placeActivityDirect(actB.id, s2);
                        if(actC) this.placeActivityDirect(actC.id, destC);
                        if(actD) this.placeActivityDirect(actD.id, destD);

                        const safeBlock = this.isLessonBlockSafe(actA, actB) &&
                          (!actC || this.isLessonBlockSafe(actC)) &&
                          (!actD || this.isLessonBlockSafe(actD));

                        if(safeBlock){
                          const m = this.evaluateMetrics();
                          if(this.compareMetrics(m, currentBest, "optimize_singletons") < 0 && m.soBuoiTrong2 <= maxGap2Limit){
                            currentBest = { ...m };
                            anyImproved = true;
                            passImproved = true;
                            pairResolved = true;
                            if(typeof onProgress === "function") onProgress(currentBest);
                            break;
                          }
                        }
                        this.unplaceActivity(actA.id);
                        this.unplaceActivity(actB.id);
                        if(actC) this.unplaceActivity(actC.id);
                        if(actD) this.unplaceActivity(actD.id);
                      }

                      this.placeActivityDirect(actA.id, sA);
                      this.placeActivityDirect(actB.id, sB);
                      if(actC) this.placeActivityDirect(actC.id, s1);
                      if(actD) this.placeActivityDirect(actD.id, s2);
                    }
                    if(pairResolved) break;
                  }
                  if(pairResolved) break;
                }
                if(pairResolved) break;
              }
              if(pairResolved) break;
            }
            if(pairResolved) break;
          }
          if(pairResolved) break;
        }
      }
    });
    if(!passImproved) break;
  }
  return anyImproved ? currentBest : null;
};

console.log("=== RUNNING FULL OPTIMIZE SINGLETONS ===");
let m = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m));

const r1 = engine.tryConsolidateTeacherSingletons(m, m);
if(r1) m = r1;
console.log("After tryConsolidateTeacherSingletons:", JSON.stringify(m));

const r2 = engine.tryConsolidatePairSingletons(m, m);
if(r2) m = r2;
console.log("After tryConsolidatePairSingletons:", JSON.stringify(m));

console.log("\nResidual singletons:", JSON.stringify(engine.getResidualSingletons()));

