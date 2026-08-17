const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

// Operator 1: Extreme Span Crusher
FetTimetableEngine.prototype.tryCrushExtremeSpanGaps = function(bestMetrics, initialMetrics, mode = "optimize_gap2") {
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
        const edgeStart = taught[0];

        // 1. Try relocating edgeEnd
        if (edgeEnd.actId >= 0) {
          const actEnd = this.activities[edgeEnd.actId];
          if (actEnd && !actEnd.isFixed) {
            const cg = this.classGrid.get(actEnd.classId);
            if (cg) {
              for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                  const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                  for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                    const slotDest = sStart2 + p2;
                    if (slotDest === edgeEnd.slot || cg[slotDest] === -2) continue;

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
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    } else {
                      const actDest = this.activities[actDestId];
                      if (!actDest || actDest.isFixed || actDest.duration !== actEnd.duration) continue;

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

        // 2. Try relocating edgeStart
        if (!resolved && edgeStart.actId >= 0) {
          const actStart = this.activities[edgeStart.actId];
          if (actStart && !actStart.isFixed) {
            const cg = this.classGrid.get(actStart.classId);
            if (cg) {
              for (let d2 = 0; d2 < DAYS_LIST.length && !resolved; d2++) {
                for (let b2 = 0; b2 < SESSIONS_LIST.length && !resolved; b2++) {
                  const sStart2 = d2 * SLOTS_PER_DAY + b2 * PERIODS;
                  for (let p2 = 0; p2 < PERIODS && !resolved; p2++) {
                    const slotDest = sStart2 + p2;
                    if (slotDest === edgeStart.slot || cg[slotDest] === -2) continue;

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
                          }
                        }
                      }
                      if (!resolved) this.restoreStateSnapshot(snap);
                    } else {
                      const actDest = this.activities[actDestId];
                      if (!actDest || actDest.isFixed || actDest.duration !== actStart.duration) continue;

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

// Operator 3: Merge same teacher split periods in session
FetTimetableEngine.prototype.tryMergeSameTeacherSplitPeriodsInSession = function(bestMetrics, initialMetrics, mode = "optimize_gap2") {
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
        const actsInSession = [];
        for (let p = 0; p < PERIODS; p++) {
          const aId = grid[sStart + p];
          if (aId >= 0) actsInSession.push({ p, actId: aId, slot: sStart + p });
        }

        if (actsInSession.length !== 2) continue;
        const pFirst = actsInSession[0].p;
        const pSecond = actsInSession[1].p;
        if (pSecond - pFirst <= 1) continue;

        const act1 = this.activities[actsInSession[0].actId];
        const act2 = this.activities[actsInSession[1].actId];
        if (!act1 || !act2 || act1.isFixed || act2.isFixed) continue;

        const candidates = [
          { moveAct: act2, fromSlot: actsInSession[1].slot, toSlot: sStart + pFirst + 1 },
          { moveAct: act1, fromSlot: actsInSession[0].slot, toSlot: sStart + pSecond - 1 }
        ];

        let resolved = false;
        for (const cand of candidates) {
          const cg = this.classGrid.get(cand.moveAct.classId);
          if (!cg || cg[cand.toSlot] === -2) continue;

          const displacedId = cg[cand.toSlot];
          if (displacedId < 0) {
            const snap = this.captureStateSnapshot();
            this.unplaceActivity(cand.moveAct.id);
            const r = this.getConflictsForSlot(cand.moveAct, cand.toSlot);
            if (r.possible && !r.conflicts.length) {
              this.placeActivityDirect(cand.moveAct.id, cand.toSlot);
              if (this.isLessonBlockSafe(cand.moveAct) && this.isDailySubjectLimitSafe(cand.moveAct, cand.toSlot)) {
                const m = this.evaluateMetrics();
                if (this.compareMetrics(m, currentBest, mode) < 0) {
                  currentBest = { ...m };
                  anyImproved = true;
                  resolved = true;
                }
              }
            }
            if (!resolved) this.restoreStateSnapshot(snap);
          } else {
            const displacedAct = this.activities[displacedId];
            if (!displacedAct || displacedAct.isFixed) continue;

            const snap = this.captureStateSnapshot();
            this.unplaceActivity(cand.moveAct.id);
            this.unplaceActivity(displacedAct.id);

            const r1 = this.getConflictsForSlot(cand.moveAct, cand.toSlot);
            const r2 = this.getConflictsForSlot(displacedAct, cand.fromSlot);

            if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
              this.placeActivityDirect(cand.moveAct.id, cand.toSlot);
              this.placeActivityDirect(displacedAct.id, cand.fromSlot);
              if (this.isLessonBlockSafe(cand.moveAct, displacedAct) &&
                  this.isDailySubjectLimitSafe(cand.moveAct, cand.toSlot) &&
                  this.isDailySubjectLimitSafe(displacedAct, cand.fromSlot)) {
                const m = this.evaluateMetrics();
                if (this.compareMetrics(m, currentBest, mode) < 0) {
                  currentBest = { ...m };
                  anyImproved = true;
                  resolved = true;
                }
              }
            }
            if (!resolved) this.restoreStateSnapshot(snap);
          }
          if (resolved) break;
        }
      }
    }
  }

  return anyImproved ? currentBest : null;
};

const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

let m = engine.evaluateMetrics();
console.log("Initial Metrics:", m);

for(let round = 1; round <= 15; round++) {
  let imp = false;
  
  const r1 = engine.tryCrushExtremeSpanGaps(m, m, "optimize_gap2");
  if(r1 && engine.compareMetrics(r1, m, "optimize_gap2") < 0) {
    m = { ...r1 }; imp = true;
    console.log(`[R${round} Extreme] Gap2: ${m.soBuoiTrong2}, Gap1: ${m.soBuoiTrong1}, Sessions: ${m.tsBuoiDay}`);
  }

  const r2 = engine.tryMergeSameTeacherSplitPeriodsInSession(m, m, "optimize_gap2");
  if(r2 && engine.compareMetrics(r2, m, "optimize_gap2") < 0) {
    m = { ...r2 }; imp = true;
    console.log(`[R${round} Merge Split] Gap2: ${m.soBuoiTrong2}, Gap1: ${m.soBuoiTrong1}, Sessions: ${m.tsBuoiDay}`);
  }

  const r3 = engine.tryBorrowLessonFromRichSessions(m, m, "optimize_gap2");
  if(r3 && engine.compareMetrics(r3, m, "optimize_gap2") < 0) {
    m = { ...r3 }; imp = true;
    console.log(`[R${round} Borrow Rich] Gap2: ${m.soBuoiTrong2}, Gap1: ${m.soBuoiTrong1}, Sessions: ${m.tsBuoiDay}`);
  }
  
  if(!imp) break;
}

console.log("\n=== FINAL RESULT ===");
console.log("soBuoiTrong2:", m.soBuoiTrong2);
console.log("Full Metrics:", m);
