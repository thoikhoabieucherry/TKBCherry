const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
eval(engineCode);

FetTimetableEngine.prototype.tryInterDayRelocateGapLesson = function(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
  let currentBest = { ...bestMetrics };
  let anyImproved = false;

  const PERIODS = 5;
  const SLOTS_PER_DAY = 10;
  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];

  // Find teachers with gap-2
  for (const [tKey, grid] of this.teacherGrid.entries()) {
    if (!tKey || !this.isScoredTeacher(tKey)) continue;

    for (let dSrc = 0; dSrc < DAYS_LIST.length; dSrc++) {
      for (let bSrc = 0; bSrc < SESSIONS_LIST.length; bSrc++) {
        const sStartSrc = dSrc * SLOTS_PER_DAY + bSrc * PERIODS;
        const taughtSrc = [];
        for (let p = 0; p < PERIODS; p++) {
          const actId = grid[sStartSrc + p];
          if (actId >= 0 || actId === -3) taughtSrc.push(p);
        }

        if (taughtSrc.length < 2) continue;
        const spanSrc = taughtSrc[taughtSrc.length - 1] - taughtSrc[0] + 1;
        const gapsSrc = spanSrc - taughtSrc.length;
        if (gapsSrc < 2) continue;

        // Try moving outlier period (taughtSrc[0] or taughtSrc[last]) to another day
        const outliers = [taughtSrc[0], taughtSrc[taughtSrc.length - 1]];
        let resolved = false;

        for (const pSrc of outliers) {
          const actSrcId = grid[sStartSrc + pSrc];
          if (actSrcId < 0) continue;
          const actSrc = this.activities[actSrcId];
          if (!actSrc || actSrc.isFixed || actSrc.duration !== 1) continue;

          const cid = actSrc.classId;
          const cg = this.classGrid.get(cid);
          if (!cg) continue;

          // Try relocating actSrc to all other days/sessions for class cid
          for (let dDest = 0; dDest < DAYS_LIST.length && !resolved; dDest++) {
            for (let bDest = 0; bDest < SESSIONS_LIST.length && !resolved; bDest++) {
              if (dDest === dSrc && bDest === bSrc) continue;
              const sStartDest = dDest * SLOTS_PER_DAY + bDest * PERIODS;

              // Check if class cid is active in this session (not all OFF)
              let hasClassSlot = false;
              for (let p = 0; p < PERIODS; p++) {
                if (cg[sStartDest + p] !== -2) hasClassSlot = true; // -2 is off
              }
              if (!hasClassSlot) continue;

              for (let pDest = 0; pDest < PERIODS; pDest++) {
                const slotDest = sStartDest + pDest;
                if (cg[slotDest] === -2) continue; // Class off

                const actDestId = cg[slotDest];
                if (actDestId < 0) {
                  // Empty slot
                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actSrc.id);
                  const r = this.getConflictsForSlot(actSrc, slotDest);
                  if (r.possible && !r.conflicts.length) {
                    this.placeActivityDirect(actSrc.id, slotDest);
                    if (this.isLessonBlockSafe(actSrc)) {
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
                  // Swap actSrc(slotSrc) <-> actDest(slotDest) in class cid
                  const actDest = this.activities[actDestId];
                  if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

                  const snap = this.captureStateSnapshot();
                  this.unplaceActivity(actSrc.id);
                  this.unplaceActivity(actDest.id);

                  const r1 = this.getConflictsForSlot(actSrc, slotDest);
                  const r2 = this.getConflictsForSlot(actDest, sStartSrc + pSrc);

                  if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                    this.placeActivityDirect(actSrc.id, slotDest);
                    this.placeActivityDirect(actDest.id, sStartSrc + pSrc);
                    if (this.isLessonBlockSafe(actSrc, actDest)) {
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
            }
          }
          if (resolved) break;
        }
      }
    }
  }

  return anyImproved ? currentBest : null;
};

// Test on snapshot
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default_gap7.json", 'utf8'));
const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

console.log("Initial Metrics for snapshot:", engine.evaluateMetrics());

for (let r = 0; r < 5; r++) {
  const res = engine.tryInterDayRelocateGapLesson(engine.evaluateMetrics(), engine.evaluateMetrics(), "optimize_gap2", (m) => {
    console.log("Improvement found:", m);
  });
  if (!res) break;
}

console.log("\n=== FINAL METRICS AFTER INTER-DAY RELOCATION ===");
console.log(engine.evaluateMetrics());
