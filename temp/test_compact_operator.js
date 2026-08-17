const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');

// We add tryCompactTeacherSpan directly into engine prototype
eval(engineCode);

FetTimetableEngine.prototype.tryCompactTeacherSpan = function(bestMetrics, initialMetrics, mode = "optimize_gap2", onProgress = null) {
  let currentBest = { ...bestMetrics };
  let anyImproved = false;

  const PERIODS = 5;
  const SLOTS_PER_DAY = 10;
  const DAYS_LIST = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
  const SESSIONS_LIST = ["sang", "chieu"];

  // Find all teachers with gap-2
  for (const [tKey, grid] of this.teacherGrid.entries()) {
    if (!tKey || !this.isScoredTeacher(tKey)) continue;

    for (let d = 0; d < DAYS_LIST.length; d++) {
      for (let b = 0; b < SESSIONS_LIST.length; b++) {
        const sStart = d * SLOTS_PER_DAY + b * PERIODS;
        const taught = [];
        for (let p = 0; p < PERIODS; p++) {
          const actId = grid[sStart + p];
          if (actId >= 0 || actId === -3) taught.push(p);
        }

        if (taught.length < 2) continue;
        const span = taught[taught.length - 1] - taught[0] + 1;
        const gaps = span - taught.length;
        if (gaps < 2) continue; // Only process gap >= 2

        // Teacher tKey has gap >= 2 in this session (d, b)
        // We try to move outlier periods (taught[0] or taught[taught.length-1]) towards the adjacent block
        const outliers = [taught[0], taught[taught.length - 1]];
        let resolved = false;

        for (const pSrc of outliers) {
          const actSrcId = grid[sStart + pSrc];
          if (actSrcId < 0) continue; // Can't move locked external
          const actSrc = this.activities[actSrcId];
          if (!actSrc || actSrc.isFixed || actSrc.duration !== 1) continue;

          const cid = actSrc.classId;
          const cg = this.classGrid.get(cid);
          if (!cg) continue;

          // Target periods that reduce gap: all pDest between taught[0] and taught[taught.length-1]
          // or right next to the other taught periods
          for (let pDest = 0; pDest < PERIODS; pDest++) {
            if (pDest === pSrc || taught.includes(pDest)) continue;

            const slotSrc = sStart + pSrc;
            const slotDest = sStart + pDest;

            // Check if moving actSrc from slotSrc to slotDest in class cid is feasible
            const actDestId = cg[slotDest];

            if (actDestId < 0) {
              // Empty slot in class cid! Direct move!
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
              if (resolved) break;
            } else {
              // Slot is occupied by actDest in class cid
              const actDest = this.activities[actDestId];
              if (!actDest || actDest.isFixed || actDest.duration !== 1) continue;

              // 1. Try direct 2-way swap in class cid: actSrc(slotSrc) <-> actDest(slotDest)
              const snap = this.captureStateSnapshot();
              this.unplaceActivity(actSrc.id);
              this.unplaceActivity(actDest.id);

              const r1 = this.getConflictsForSlot(actSrc, slotDest);
              const r2 = this.getConflictsForSlot(actDest, slotSrc);

              if (r1.possible && !r1.conflicts.length && r2.possible && !r2.conflicts.length) {
                this.placeActivityDirect(actSrc.id, slotDest);
                this.placeActivityDirect(actDest.id, slotSrc);
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
              if (resolved) break;

              // 2. Try 3-way cycle: actSrc -> slotDest, actDest -> slotOther in class cid (or across classes)
              for (let pOther = 0; pOther < PERIODS && !resolved; pOther++) {
                if (pOther === pSrc || pOther === pDest) continue;
                const slotOther = sStart + pOther;
                const actOtherId = cg[slotOther];
                if (actOtherId < 0) continue;
                const actOther = this.activities[actOtherId];
                if (!actOther || actOther.isFixed || actOther.duration !== 1) continue;

                // Cycle A: actSrc -> slotDest, actDest -> slotOther, actOther -> slotSrc
                const snap3 = this.captureStateSnapshot();
                this.unplaceActivity(actSrc.id);
                this.unplaceActivity(actDest.id);
                this.unplaceActivity(actOther.id);

                const c1 = this.getConflictsForSlot(actSrc, slotDest);
                const c2 = this.getConflictsForSlot(actDest, slotOther);
                const c3 = this.getConflictsForSlot(actOther, slotSrc);

                if (c1.possible && !c1.conflicts.length && c2.possible && !c2.conflicts.length && c3.possible && !c3.conflicts.length) {
                  this.placeActivityDirect(actSrc.id, slotDest);
                  this.placeActivityDirect(actDest.id, slotOther);
                  this.placeActivityDirect(actOther.id, slotSrc);
                  if (this.isLessonBlockSafe(actSrc, actDest, actOther)) {
                    const m = this.evaluateMetrics();
                    if (this.compareMetrics(m, currentBest, mode) < 0) {
                      currentBest = { ...m };
                      anyImproved = true;
                      resolved = true;
                      if (typeof onProgress === "function") onProgress(currentBest);
                    }
                  }
                }
                if (!resolved) this.restoreStateSnapshot(snap3);
                if (resolved) break;

                // Cycle B: actSrc -> slotDest, actOther -> slotDest(slotSrc), actDest -> slotSrc(slotOther)...
                const snap3b = this.captureStateSnapshot();
                this.unplaceActivity(actSrc.id);
                this.unplaceActivity(actDest.id);
                this.unplaceActivity(actOther.id);

                const b1 = this.getConflictsForSlot(actSrc, slotDest);
                const b2 = this.getConflictsForSlot(actOther, slotDest); // not valid
                const b3 = this.getConflictsForSlot(actDest, slotOther);
                // Cycle: actSrc -> slotDest, actDest -> slotSrc, (tested in 2-way)
                this.restoreStateSnapshot(snap3b);
              }
              if (resolved) break;
            }
          }
          if (resolved) break;
        }
      }
    }
  }

  return anyImproved ? currentBest : null;
};

// Test on school_default_gap7.json
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default_gap7.json", 'utf8'));

const engine = new FetTimetableEngine(dataJson, {});
engine.init();
engine.loadExistingSchedule();

console.log("Initial Metrics for snapshot:", engine.evaluateMetrics());

const resCompact = engine.tryCompactTeacherSpan(engine.evaluateMetrics(), engine.evaluateMetrics(), "optimize_gap2", (m) => {
  console.log("Live Progress in tryCompactTeacherSpan:", m);
});

console.log("\nResult after tryCompactTeacherSpan:", resCompact || "No direct improvement");
if (resCompact) {
  console.log("Final Metrics:", engine.evaluateMetrics());
}
