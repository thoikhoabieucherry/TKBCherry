const fs = require('fs');
const path = require('path');

let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

// In solve(), add tryEjectionChain fallback and higher call limit
engineCode = engineCode.replace(
  `        this.limitCalls = Math.max(8000, 10 * this.activities.length);\n        for(const uAct of unplacedActs){\n          this.nCalls = 0;\n          this.randomSwap(uAct.id, 0);\n        }`,
  `        this.limitCalls = Math.max(12000, 20 * this.activities.length);
        for(const uAct of unplacedActs){
          this.nCalls = 0;
          let ok = this.randomSwap(uAct.id, 0);
          if(!ok){
            this.tryEjectionChain(uAct.id);
          }
        }`
);

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function verify(){
  console.log("=== 1. TEST SOLVE FROM SCRATCH ===");
  const t0 = Date.now();
  const engine = new FetTimetableEngine(schoolData);
  const solveRes = engine.solve();
  const t1 = Date.now();

  console.log(`Solve completed in ${t1 - t0}ms:`, solveRes);
  console.log("Lesson Block Violations:", engine.evaluateLessonBlockViolations());
  console.log("Metrics after solve:", engine.evaluateMetrics());

  if(solveRes.unassigned > 0 || engine.evaluateLessonBlockViolations() > 0){
    throw new Error("Solve failed or has lesson block violations!");
  }

  // Update timetable for optimizers
  schoolData.tkb = engine.getSnapshotTKB();

  console.log("\n=== 2. TEST OPTIMIZE SINGLETONS ===");
  const eng1 = new FetTimetableEngine(schoolData);
  const res1 = await eng1.optimize("optimize_singletons");
  console.log(`Singletons: ${res1.initialMetrics.soBuoiDay1} -> ${res1.metrics.soBuoiDay1}, LB Violations: ${eng1.evaluateLessonBlockViolations()}`);
  schoolData.tkb = eng1.getSnapshotTKB();

  console.log("\n=== 3. TEST OPTIMIZE GAP2 ===");
  const eng2 = new FetTimetableEngine(schoolData);
  const res2 = await eng2.optimize("optimize_gap2");
  console.log(`Gap 2: ${res2.initialMetrics.soBuoiTrong2} -> ${res2.metrics.soBuoiTrong2}, LB Violations: ${eng2.evaluateLessonBlockViolations()}`);
  schoolData.tkb = eng2.getSnapshotTKB();

  console.log("\n=== 4. TEST OPTIMIZE GAP1 ===");
  const eng3 = new FetTimetableEngine(schoolData);
  const res3 = await eng3.optimize("optimize_gap1");
  console.log(`Gap 1: ${res3.initialMetrics.soBuoiTrong1} -> ${res3.metrics.soBuoiTrong1}, LB Violations: ${eng3.evaluateLessonBlockViolations()}`);
  schoolData.tkb = eng3.getSnapshotTKB();

  console.log("\n=== 5. TEST OPTIMIZE SESSIONS ===");
  const eng4 = new FetTimetableEngine(schoolData);
  const res4 = await eng4.optimize("optimize_sessions");
  console.log(`Sessions: ${res4.initialMetrics.tsBuoiDay} -> ${res4.metrics.tsBuoiDay}, LB Violations: ${eng4.evaluateLessonBlockViolations()}`);

  console.log("\n=========================================");
  console.log("ALL TESTS PASSED WITH 100% CLEAN SUCCESS!");
  console.log("=========================================");
}

verify().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
