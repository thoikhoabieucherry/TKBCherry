const fs = require('fs');

const dongkhoiData = JSON.parse(fs.readFileSync('scratch/dongkhoi_base_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

class DedicatedSingletonOptimizer {
  constructor(engine) {
    this.eng = engine;
  }

  // Lexicographic comparator
  isBetter(mA, mB) {
    if (mA.hardViolations !== mB.hardViolations) return mA.hardViolations < mB.hardViolations;
    if (mA.soBuoiDay1 !== mB.soBuoiDay1) return mA.soBuoiDay1 < mB.soBuoiDay1;
    if (mA.soBuoiTrong2 !== mB.soBuoiTrong2) return mA.soBuoiTrong2 < mB.soBuoiTrong2;
    if (mA.soBuoiTrong1 !== mB.soBuoiTrong1) return mA.soBuoiTrong1 < mB.soBuoiTrong1;
    if (mA.tsBuoiDay !== mB.tsBuoiDay) return mA.tsBuoiDay < mB.tsBuoiDay;
    return false;
  }

  run(maxRestarts = 10, timeLimitMs = 15000) {
    const startTime = Date.now();
    let bestGlobalMetrics = this.eng.evaluateMetrics();
    bestGlobalMetrics.hardViolations = this.eng.evaluateLessonBlockViolations();
    
    let bestGlobalPlacement = this.eng.actPlacement.slice();

    for (let restart = 0; restart < maxRestarts; restart++) {
      if (Date.now() - startTime > timeLimitMs) break;
      if (bestGlobalMetrics.soBuoiDay1 === 0) break;

      // 1. PHA A: REPAIR (Target: soBuoiDay1 -> 0)
      for (let pass = 0; pass < 20; pass++) {
        if (Date.now() - startTime > timeLimitMs) break;

        let passImproved = false;

        // O1 & O3 & O5: Obliterate singletons
        const m1 = this.eng.obliterateAllTeacherSingletons(5, Infinity);
        if (m1) {
          m1.hardViolations = this.eng.evaluateLessonBlockViolations();
          if (this.isBetter(m1, bestGlobalMetrics)) {
            bestGlobalMetrics = { ...m1 };
            bestGlobalPlacement = this.eng.actPlacement.slice();
            passImproved = true;
          }
        }

        // O1 & O3: Consolidate singletons
        const m2 = this.eng.tryConsolidateTeacherSingletons(bestGlobalMetrics, bestGlobalMetrics, Infinity);
        if (m2) {
          m2.hardViolations = this.eng.evaluateLessonBlockViolations();
          if (this.isBetter(m2, bestGlobalMetrics)) {
            bestGlobalMetrics = { ...m2 };
            bestGlobalPlacement = this.eng.actPlacement.slice();
            passImproved = true;
          }
        }

        // O1 & O3: Reinforce singletons
        const m3 = this.eng.tryReinforceTeacherSingletons(bestGlobalMetrics, bestGlobalMetrics, Infinity);
        if (m3) {
          m3.hardViolations = this.eng.evaluateLessonBlockViolations();
          if (this.isBetter(m3, bestGlobalMetrics)) {
            bestGlobalMetrics = { ...m3 };
            bestGlobalPlacement = this.eng.actPlacement.slice();
            passImproved = true;
          }
        }

        if (bestGlobalMetrics.soBuoiDay1 === 0) break;
        if (!passImproved && pass >= 5) break;
      }

      // 2. PHA B: POLISH (Target: reduce internal gaps without ever increasing singletons)
      if (bestGlobalMetrics.soBuoiDay1 === 0) {
        for (let pPass = 0; pPass < 5; pPass++) {
          const mGap = this.eng.tryCrushTeacherGaps(bestGlobalMetrics, bestGlobalMetrics, "optimize_gap2");
          if (mGap && mGap.soBuoiDay1 === 0) {
            mGap.hardViolations = this.eng.evaluateLessonBlockViolations();
            if (this.isBetter(mGap, bestGlobalMetrics)) {
              bestGlobalMetrics = { ...mGap };
              bestGlobalPlacement = this.eng.actPlacement.slice();
            }
          }
        }
        break; // Achieved 0 singletons and polished!
      }

      // Controlled perturbation for next restart
      if (restart < maxRestarts - 1) {
        // Random 1-hop perturbation on free single activities
        const movableActs = this.eng.activities.filter(a => !a.isFixed && a.duration === 1);
        this.eng.rng.shuffle(movableActs);
        let pertCount = 0;
        for (const act of movableActs) {
          if (pertCount >= 2) break;
          const s1 = this.eng.actPlacement[act.id];
          if (s1 < 0) continue;
          const cGrid = this.eng.classGrid.get(act.classId);
          for (let s2 = 0; s2 < 60; s2++) {
            if (s2 === s1 || this.eng.offSlots.has(`${act.classId}|${s2}`)) continue;
            const actId2 = cGrid[s2];
            if (actId2 >= 0) {
              const act2 = this.eng.activities[actId2];
              if (act2 && !act2.isFixed && act2.duration === 1) {
                this.eng.unplaceActivity(act.id);
                this.eng.unplaceActivity(act2.id);
                const r1 = this.eng.getConflictsForSlot(act, s2);
                const r2 = this.eng.getConflictsForSlot(act2, s1);
                if (r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0) {
                  this.eng.placeActivityDirect(act.id, s2);
                  this.eng.placeActivityDirect(act2.id, s1);
                  if (this.eng.isLessonBlockSafe(act, act2)) {
                    pertCount++;
                    break;
                  }
                  this.eng.unplaceActivity(act.id);
                  this.eng.unplaceActivity(act2.id);
                }
                this.eng.placeActivityDirect(act.id, s1);
                this.eng.placeActivityDirect(act2.id, s2);
              }
            }
          }
        }
      }
    }

    // Restore absolute best
    this.eng.actPlacement = bestGlobalPlacement;
    this.eng.syncGridsFromPlacement();
    this.eng.applyToDataTKB();

    return {
      metrics: bestGlobalMetrics,
      timeMs: Date.now() - startTime
    };
  }
}

// Test on Dong Khoi
const opt = new FetTimetableEngine(dongkhoiData);
opt.loadExistingSchedule();
console.log("Initial Dong Khoi metrics:", opt.evaluateMetrics());

const runner = new DedicatedSingletonOptimizer(opt);
const result = runner.run(10, 15000);
console.log("Result Dong Khoi:", result.metrics, "in " + result.timeMs + "ms");
console.log("Lesson block violations:", opt.evaluateLessonBlockViolations());
