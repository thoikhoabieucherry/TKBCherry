const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

// Add prototypes
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

        // Try edgeEnd
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

        // Try edgeStart
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

const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

let m = engine.evaluateMetrics();
engine.tryCrushExtremeSpanGaps(m, m, "optimize_gap2");
engine.tryCrushExtremeSpanGaps(m, m, "optimize_gap2");
engine.tryBorrowLessonFromRichSessions(m, m, "optimize_gap2");

console.log("=== EXACT 2 REMAINING GAP2 TEACHERS ===");
for(const [tKey, grid] of engine.teacherGrid.entries()){
  if(!tKey || !engine.isScoredTeacher(tKey)) continue;
  const tm = engine.evaluateTeacherMetrics(tKey);
  if(tm.soBuoiTrong2 > 0){
    console.log(`\nTeacher: ${tKey} (soBuoiTrong2: ${tm.soBuoiTrong2})`);
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const acts = [];
        let hasG2 = false;
        const taught = [];
        for(let p = 0; p < 5; p++){
          const aId = grid[sStart + p];
          if(aId >= 0){
            const a = engine.activities[aId];
            acts.push(`P${p+1}: ${a.classId} (${a.subject})`);
            taught.push(p);
          } else if(aId === -3){
            acts.push(`P${p+1}: FIXED`);
            taught.push(p);
          } else {
            acts.push(`P${p+1}: _`);
          }
        }
        if(taught.length >= 2){
          const span = taught[taught.length-1] - taught[0] + 1;
          if(span - taught.length >= 2) hasG2 = true;
        }
        if(hasG2){
          console.log(`  >>> GAP2 DETECTED: ${["thu2","thu3","thu4","thu5","thu6","thu7"][d]} ${["sang","chieu"][b]}: [ ${acts.join(" | ")} ]`);
        }
      }
    }
  }
}
