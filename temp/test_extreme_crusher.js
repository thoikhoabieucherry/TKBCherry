const fs = require('fs');

// Load engine
let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

console.log("Initial Metrics:", engine.evaluateMetrics());

// Implement prototype tryCrushExtremeSpanGaps
FetTimetableEngine.prototype.tryCrushExtremeSpanGaps = function(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
  let currentBest = { ...bestMetrics };
  let anyImproved = false;

  const PERIODS = 5;
  const SLOTS_PER_DAY = 10;
  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];

  for (const [tKey, grid] of this.teacherGrid.entries()) {
    if (!tKey || !this.isScoredTeacher(tKey)) continue;

    for (let d = 0; d < DAYS_LIST.length; d++) {
      for (let b = 0; b < SESSIONS_LIST.length; b++) {
        const sStart = d * SLOTS_PER_DAY + b * PERIODS;
        const taught = [];
        for (let p = 0; p < PERIODS; p++) {
          const actId = grid[sStart + p];
          if (actId >= 0 || actId === -3) taught.push({ p, actId, slot: sStart + p });
        }

        if (taught.length < 2) continue;
        const span = taught[taught.length - 1].p - taught[0].p + 1;
        const gaps = span - taught.length;
        if (gaps < 2) continue; // Focus strictly on gap >= 2 (especially span >= 4, like [1, 5] or [1, 4])

        let resolved = false;

        // Strategy A: Move end period (P5 or P4) to adjacent of P0 (e.g. P1)
        const edgeEnd = taught[taught.length - 1];
        const edgeStart = taught[0];

        // 1. Try relocating edgeEnd to other sessions of this teacher
        if (edgeEnd.actId >= 0) {
          const actEnd = this.activities[edgeEnd.actId];
          if (actEnd && !actEnd.isFixed && actEnd.duration === 1) {
            const cg = this.classGrid.get(actEnd.classId);
            if (cg) {
              for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                  if (d2 === d && b2 === b) continue;
                  const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                  for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                    const slotDest = sStart2 + p2;
                    if (cg[slotDest] === -2) continue;

                    const actDestId = cg[slotDest];
                    if (actDestId < 0) {
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actEnd.id);
                      const r = this.getConflictsForSlot(actEnd, slotDest);
                      if (r.possible && !r.conflicts.length) {
                        this.placeActivityDirect(actEnd.id, slotDest);
                        if (this.isLessonBlockSafe(actEnd) && this.isDailySubjectLimitSafe(actEnd, slotDest)) {
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
                      const actDest = this.activities[actDestId];
                      if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actEnd.id);
                      this.unplaceActivity(actDest.id);

                      const r1 = this.getConflictsForSlot(actEnd, slotDest);
                      const r2 = this.getConflictsForSlot(actDest, edgeEnd.slot);

                      if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                        this.placeActivityDirect(actEnd.id, slotDest);
                        this.placeActivityDirect(actDest.id, edgeEnd.slot);
                        if (this.isLessonBlockSafe(actEnd, actDest) && 
                            this.isDailySubjectLimitSafe(actEnd, slotDest) && 
                            this.isDailySubjectLimitSafe(actDest, edgeEnd.slot)) {
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
                  }
                }
              }
            }
          }
        }

        // 2. Try relocating edgeStart to other sessions of this teacher
        if (!resolved && edgeStart.actId >= 0) {
          const actStart = this.activities[edgeStart.actId];
          if (actStart && !actStart.isFixed && actStart.duration === 1) {
            const cg = this.classGrid.get(actStart.classId);
            if (cg) {
              for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                  if (d2 === d && b2 === b) continue;
                  const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                  for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                    const slotDest = sStart2 + p2;
                    if (cg[slotDest] === -2) continue;

                    const actDestId = cg[slotDest];
                    if (actDestId < 0) {
                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actStart.id);
                      const r = this.getConflictsForSlot(actStart, slotDest);
                      if (r.possible && !r.conflicts.length) {
                        this.placeActivityDirect(actStart.id, slotDest);
                        if (this.isLessonBlockSafe(actStart) && this.isDailySubjectLimitSafe(actStart, slotDest)) {
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
                      const actDest = this.activities[actDestId];
                      if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

                      const snap = this.captureStateSnapshot();
                      this.unplaceActivity(actStart.id);
                      this.unplaceActivity(actDest.id);

                      const r1 = this.getConflictsForSlot(actStart, slotDest);
                      const r2 = this.getConflictsForSlot(actDest, edgeStart.slot);

                      if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                        this.placeActivityDirect(actStart.id, slotDest);
                        this.placeActivityDirect(actDest.id, edgeStart.slot);
                        if (this.isLessonBlockSafe(actStart, actDest) && 
                            this.isDailySubjectLimitSafe(actStart, slotDest) && 
                            this.isDailySubjectLimitSafe(actDest, edgeStart.slot)) {
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

async function testExtremeCrusher() {
  console.log("=== RUNNING tryCrushExtremeSpanGaps ===");
  let m = engine.evaluateMetrics();
  for(let round = 1; round <= 10; round++) {
    const res = engine.tryCrushExtremeSpanGaps(m, m, "optimize_gap2");
    if(res) {
      m = { ...res };
      console.log(`[Round ${round}] New Metrics: Gap2=${m.soBuoiTrong2}, Singletons=${m.soBuoiDay1}, Sessions=${m.tsBuoiDay}, Gap1=${m.soBuoiTrong1}`);
    } else {
      console.log(`[Round ${round}] No more extreme gap improvements.`);
      break;
    }
  }
}

testExtremeCrusher();
