const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

// Add prototype for Relax & Repair
FetTimetableEngine.prototype.tryRelaxAndRepairGapGaps = function(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
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
        if (gaps < 1) continue;

        let resolved = false;
        const edgeEnd = taught[taught.length - 1];

        // Pick movable activity from gap session
        if (edgeEnd.actId >= 0) {
          const actToMove = this.activities[edgeEnd.actId];
          if (actToMove && !actToMove.isFixed) {
            const cg = this.classGrid.get(actToMove.classId);
            if (!cg) continue;

            for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
              for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                if (d2 === d && b2 === b) continue;
                const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;

                for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                  const targetSlot = sStart2 + p2;
                  if (cg[targetSlot] === -2) continue;

                  const snap = this.captureStateSnapshot();
                  let placed = false;

                  const displacedId = cg[targetSlot];
                  if (displacedId < 0) {
                    this.unplaceActivity(actToMove.id);
                    const r = this.getConflictsForSlot(actToMove, targetSlot);
                    if (r.possible && !r.conflicts.length) {
                      this.placeActivityDirect(actToMove.id, targetSlot);
                      placed = true;
                    }
                  } else {
                    const displacedAct = this.activities[displacedId];
                    if (displacedAct && !displacedAct.isFixed && displacedAct.duration === actToMove.duration) {
                      this.unplaceActivity(actToMove.id);
                      this.unplaceActivity(displacedAct.id);

                      const r1 = this.getConflictsForSlot(actToMove, targetSlot);
                      const r2 = this.getConflictsForSlot(displacedAct, edgeEnd.slot);

                      if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                        this.placeActivityDirect(actToMove.id, targetSlot);
                        this.placeActivityDirect(displacedAct.id, edgeEnd.slot);
                        placed = true;
                      }
                    }
                  }

                  if (placed) {
                    // Feasibility & Constraint Check: ensure blocks intact and daily limits safe
                    const isBlockOk = this.isLessonBlockSafe(actToMove);
                    const isDailyLimitOk = this.isDailySubjectLimitSafe(actToMove, targetSlot);

                    if (isBlockOk && isDailyLimitOk) {
                      const m = this.evaluateMetrics();
                      if (this.compareMetrics(m, currentBest, mode) < 0) {
                        currentBest = { ...m };
                        anyImproved = true;
                        resolved = true;
                        if (typeof onProgress === "function") onProgress(currentBest);
                      }
                    }
                  }

                  if (!resolved) {
                    this.restoreStateSnapshot(snap);
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

const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

console.log("=== TESTING RELAX & REPAIR ON SCHOOL_DEFAULT ===");
let m = engine.evaluateMetrics();
console.log("Initial Metrics:", m);

for(let r = 1; r <= 5; r++){
  const res = engine.tryRelaxAndRepairGapGaps(m, m, "optimize_gap2");
  if(res && engine.compareMetrics(res, m, "optimize_gap2") < 0){
    m = { ...res };
    console.log(`[Round ${r}] New Metrics: Gap2=${m.soBuoiTrong2}, Gap1=${m.soBuoiTrong1}, Sessions=${m.tsBuoiDay}`);
  } else {
    break;
  }
}
