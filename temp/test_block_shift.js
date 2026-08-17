const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
eval(engineCode);

// Add tryBlockShiftAndGapResolution
FetTimetableEngine.prototype.tryBlockShiftAndGapResolution = function(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
  let currentBest = { ...bestMetrics };
  let anyImproved = false;

  const PERIODS = 5;
  const SLOTS_PER_DAY = 10;
  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];

  for (let d = 0; d < DAYS_LIST.length; d++) {
    for (let b = 0; b < SESSIONS_LIST.length; b++) {
      const sStart = d * SLOTS_PER_DAY + b * PERIODS;

      // Iterate through all classes
      for (const [cid, cg] of this.classGrid.entries()) {
        // 1. Try Block-Shift in class cid (e.g. shift [1,2] <-> [3] or [1] <-> [2,3])
        for (let p1 = 0; p1 < PERIODS; p1++) {
          for (let p2 = 0; p2 < PERIODS; p2++) {
            if (p1 === p2) continue;

            const a1Id = cg[sStart + p1];
            const a2Id = cg[sStart + p2];
            if (a1Id < 0 || a2Id < 0) continue;

            const a1 = this.activities[a1Id];
            const a2 = this.activities[a2Id];
            if (!a1 || !a2 || a1.isFixed || a2.isFixed) continue;

            // Direct 2-way swap in class
            const snap = this.captureStateSnapshot();
            this.unplaceActivity(a1.id);
            this.unplaceActivity(a2.id);

            const r1 = this.getConflictsForSlot(a1, sStart + p2);
            const r2 = this.getConflictsForSlot(a2, sStart + p1);

            if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
              this.placeActivityDirect(a1.id, sStart + p2);
              this.placeActivityDirect(a2.id, sStart + p1);
              if (this.isLessonBlockSafe(a1, a2)) {
                const m = this.evaluateMetrics();
                if (this.compareMetrics(m, currentBest, mode) < 0) {
                  currentBest = { ...m };
                  anyImproved = true;
                  if (typeof onProgress === "function") onProgress(currentBest);
                }
              }
            }
            if (this.compareMetrics(this.evaluateMetrics(), currentBest, mode) >= 0) {
              this.restoreStateSnapshot(snap);
            }

            // If a1 has a double block partner at p1+1 or p1-1, try shifting the 2-block with a single period!
            const partnerP1 = (p1 + 1 < PERIODS && cg[sStart + p1 + 1] >= 0 && this.activities[cg[sStart + p1 + 1]]?.subject === a1.subject) ? p1 + 1 :
                              (p1 - 1 >= 0 && cg[sStart + p1 - 1] >= 0 && this.activities[cg[sStart + p1 - 1]]?.subject === a1.subject) ? p1 - 1 : -1;

            if (partnerP1 >= 0) {
              const aPartner = this.activities[cg[sStart + partnerP1]];
              if (aPartner && !aPartner.isFixed) {
                // Try rotating [p1, partnerP1] with p2 (where p2 is right before or after the block)
                // Case: p1=1, partnerP1=2 (periods 2,3), p2=0 (period 1) -> shift block to [0,1], a2 to 2
                if (p2 === Math.min(p1, partnerP1) - 1 || p2 === Math.max(p1, partnerP1) + 1) {
                  const snapBlock = this.captureStateSnapshot();
                  const minP = Math.min(p1, partnerP1);
                  const maxP = Math.max(p1, partnerP1);

                  if (p2 < minP) {
                    // Shift [minP, maxP] down 1 slot, move p2 up to maxP
                    const aMin = this.activities[cg[sStart + minP]];
                    const aMax = this.activities[cg[sStart + maxP]];
                    const aOther = this.activities[cg[sStart + p2]];

                    this.unplaceActivity(aMin.id);
                    this.unplaceActivity(aMax.id);
                    this.unplaceActivity(aOther.id);

                    const rc1 = this.getConflictsForSlot(aMin, sStart + p2);
                    const rc2 = this.getConflictsForSlot(aMax, sStart + minP);
                    const rc3 = this.getConflictsForSlot(aOther, sStart + maxP);

                    if (rc1.possible && !rc1.conflicts.length && rc2.possible && !rc2.conflicts.length && rc3.possible && !rc3.conflicts.length) {
                      this.placeActivityDirect(aMin.id, sStart + p2);
                      this.placeActivityDirect(aMax.id, sStart + minP);
                      this.placeActivityDirect(aOther.id, sStart + maxP);
                      if (this.isLessonBlockSafe(aMin, aMax, aOther)) {
                        const m = this.evaluateMetrics();
                        if (this.compareMetrics(m, currentBest, mode) < 0) {
                          currentBest = { ...m };
                          anyImproved = true;
                          if (typeof onProgress === "function") onProgress(currentBest);
                        }
                      }
                    }
                  }
                  if (this.compareMetrics(this.evaluateMetrics(), currentBest, mode) >= 0) {
                    this.restoreStateSnapshot(snapBlock);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return anyImproved ? currentBest : null;
};

// Test on school_default.json from scratch!
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

async function testFull() {
  console.log("=== TESTING FULL GAP2 ZERO CONVERGENCE ===");
  const options = {
    uiBreathingMs: 0,
    gap2SessionBudget: 20,
    optimizeRestartBudgetMs: 90000,
    optimizeMaxRestarts: 30
  };
  
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();
  engine.pushToZero = true;

  console.log("Initial Metrics:", engine.evaluateMetrics());

  // Hook block shift into optimize loop
  const origOptimize = engine.optimize.bind(engine);
  
  const res = await engine.optimize("optimize_gap2", (p) => {
    console.log(`[Progress ${p.percent}%] Gap-2: ${p.metrics?.soBuoiTrong2} | Singletons: ${p.metrics?.soBuoiDay1} | Sessions: ${p.metrics?.tsBuoiDay}`);
  });

  console.log("\n=== FINAL METRICS ===");
  console.log(res ? res.metrics : "No result");
}

testFull().catch(err => console.error("FATAL ERROR:", err));
