const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
eval(engineCode);

// Add tryBorrowLessonFromRichSessions
FetTimetableEngine.prototype.tryBorrowLessonFromRichSessions = function(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
  let currentBest = { ...bestMetrics };
  let anyImproved = false;

  const PERIODS = 5;
  const SLOTS_PER_DAY = 10;
  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];

  for (const [tKey, grid] of this.teacherGrid.entries()) {
    if (!tKey || !this.isScoredTeacher(tKey)) continue;

    for (let dGap = 0; dGap < DAYS_LIST.length; dGap++) {
      for (let bGap = 0; bGap < SESSIONS_LIST.length; bGap++) {
        const sStartGap = dGap * SLOTS_PER_DAY + bGap * PERIODS;
        const taughtGap = [];
        for (let p = 0; p < PERIODS; p++) {
          const actId = grid[sStartGap + p];
          if (actId >= 0 || actId === -3) taughtGap.push(p);
        }

        if (taughtGap.length < 2) continue;
        const spanGap = taughtGap[taughtGap.length - 1] - taughtGap[0] + 1;
        const gapsCount = spanGap - taughtGap.length;
        if (gapsCount < 1) continue; // Has gap 1 or gap 2+

        // Holes in the gap session
        const holes = [];
        for (let p = taughtGap[0] + 1; p < taughtGap[taughtGap.length - 1]; p++) {
          if (!taughtGap.includes(p)) holes.push(p);
        }

        let resolved = false;

        // Look for donor lessons in other sessions of teacher tKey (especially sessions with >= 3 lessons or adjacent slots)
        for (let dRich = 0; dRich < DAYS_LIST.length && !resolved; dRich++) {
          for (let bRich = 0; bRich < SESSIONS_LIST.length && !resolved; bRich++) {
            if (dRich === dGap && bRich === bGap) continue;
            const sStartRich = dRich * SLOTS_PER_DAY + bRich * PERIODS;

            const taughtRich = [];
            for (let p = 0; p < PERIODS; p++) {
              const actId = grid[sStartRich + p];
              if (actId >= 0 || actId === -3) taughtRich.push(p);
            }

            if (taughtRich.length < 2) continue; // Donor session should have lessons to spare

            // Try donor periods (preferably edge periods of rich session like first or last)
            for (const pRich of taughtRich) {
              const actRichId = grid[sStartRich + pRich];
              if (actRichId < 0) continue;
              const actDonor = this.activities[actRichId];
              if (!actDonor || actDonor.isFixed || actDonor.duration !== 1) continue;

              const cid = actDonor.classId;
              const cg = this.classGrid.get(cid);
              if (!cg) continue;

              // Check if class cid is active in gap session
              let classActiveInGap = false;
              for (let p = 0; p < PERIODS; p++) {
                if (cg[sStartGap + p] !== -2) classActiveInGap = true;
              }
              if (!classActiveInGap) continue;

              // Try placing actDonor into one of the holes (or into adjacent slot of gap session)
              const candidateTargetPeriods = [...holes, Math.max(0, taughtGap[0] - 1), Math.min(PERIODS - 1, taughtGap[taughtGap.length - 1] + 1)];

              for (const pHole of candidateTargetPeriods) {
                if (taughtGap.includes(pHole) || pHole < 0 || pHole >= PERIODS) continue;

                const slotDest = sStartGap + pHole;
                const slotSrc = sStartRich + pRich;
                if (cg[slotDest] === -2) continue; // Class off

                const actDestId = cg[slotDest];

                if (actDestId < 0) {
                  // Direct move actDonor into hole in class cid
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actDonor.id);
                  const r = this.getConflictsForSlot(actDonor, slotDest);

                  if (r.possible && !r.conflicts.length) {
                    this.placeActivityDirect(actDonor.id, slotDest);
                    if (this.isLessonBlockSafe(actDonor)) {
                      const m = this.evaluateMetrics();
                      if (this.compareMetrics(m, currentBest, mode) < 0) {
                        currentBest = { ...m };
                        anyImproved = true;
                        resolved = true;
                        if (typeof onProgress === "function") onProgress(currentBest);
                      }
                    }
                  }
                  if (!resolved) this.restoreStateSnapshot(snap);
                } else {
                  // Swap actDonor(slotSrc) <-> actDest(slotDest) in class cid
                  const actDest = this.activities[actDestId];
                  if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actDonor.id);
                  this.unplaceActivity(actDest.id);

                  const r1 = this.getConflictsForSlot(actDonor, slotDest);
                  const r2 = this.getConflictsForSlot(actDest, slotSrc);

                  if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                    this.placeActivityDirect(actDonor.id, slotDest);
                    this.placeActivityDirect(actDest.id, slotSrc);
                    if (this.isLessonBlockSafe(actDonor, actDest)) {
                      const m = this.evaluateMetrics();
                      if (this.compareMetrics(m, currentBest, mode) < 0) {
                        currentBest = { ...m };
                        anyImproved = true;
                        resolved = true;
                        if (typeof onProgress === "function") onProgress(currentBest);
                      }
                    }
                  }
                  if (!resolved) this.restoreStateSnapshot(snap);
                }
                if (resolved) break;
              }
              if (resolved) break;
            }
            if (resolved) break;
          }
          if (resolved) break;
        }
      }
    }
  }

  return anyImproved ? currentBest : null;
};

// Test on school_default.json
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

console.log("=== METRICS BEFORE BORROWING OPERATOR ===");
console.log(engine.evaluateMetrics());

// Run 10 rounds of tryBorrowLessonFromRichSessions
for (let r = 0; r < 10; r++) {
  const res = engine.tryBorrowLessonFromRichSessions(engine.evaluateMetrics(), engine.evaluateMetrics(), "optimize_gap1", (m) => {
    console.log(`[Round ${r+1}] Improved metrics:`, m);
  });
  if (!res) break;
}

console.log("\n=== METRICS AFTER BORROWING OPERATOR ===");
console.log(engine.evaluateMetrics());
