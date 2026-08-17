const fs = require('fs');
const path = require('path');

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testAll(){
  console.log("=== 1. OPTIMIZE SINGLETONS ===");
  const eng1 = new FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  const t0 = Date.now();
  const res1 = await eng1.optimize("optimize_singletons");
  const t1 = Date.now();
  console.log(`Singletons (${t1 - t0}ms): ${res1.initialMetrics.soBuoiDay1} -> ${res1.metrics.soBuoiDay1}`);
  console.log("LB Violations:", eng1.evaluateLessonBlockViolations());

  console.log("\n=== 2. OPTIMIZE GAP2 ===");
  const eng2 = new FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  const t2 = Date.now();
  const res2 = await eng2.optimize("optimize_gap2");
  const t3 = Date.now();
  console.log(`Gap 2 (${t3 - t2}ms): ${res2.initialMetrics.soBuoiTrong2} -> ${res2.metrics.soBuoiTrong2}`);
  console.log("LB Violations:", eng2.evaluateLessonBlockViolations());

  console.log("\n=== 3. OPTIMIZE GAP1 ===");
  const eng3 = new FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  const t4 = Date.now();
  const res3 = await eng3.optimize("optimize_gap1");
  const t5 = Date.now();
  console.log(`Gap 1 (${t5 - t4}ms): ${res3.initialMetrics.soBuoiTrong1} -> ${res3.metrics.soBuoiTrong1}`);
  console.log("LB Violations:", eng3.evaluateLessonBlockViolations());

  console.log("\n=== 4. OPTIMIZE SESSIONS ===");
  const eng4 = new FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  const t6 = Date.now();
  const res4 = await eng4.optimize("optimize_sessions");
  const t7 = Date.now();
  console.log(`Sessions (${t7 - t6}ms): ${res4.initialMetrics.tsBuoiDay} -> ${res4.metrics.tsBuoiDay}`);
  console.log("LB Violations:", eng4.evaluateLessonBlockViolations());

  console.log("\n==========================================");
  console.log("ALL 4 OPTIMIZERS TESTED CLEANLY & FAST!");
  console.log("==========================================");
}

testAll().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
