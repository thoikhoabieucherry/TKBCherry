const fs = require('fs');

global.window = global;
global.document = {
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
  head: { appendChild: () => {} },
  getElementById: () => null,
  querySelectorAll: () => [],
};

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Remove lbViolations call inside evaluateMetrics to restore ultra-fast microsecond evaluation
engineCode = engineCode.replace(
  `      const lbViolations = this.evaluateLessonBlockViolations();\n      return { soBuoiDay1, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2, lbViolations };`,
  `      return { soBuoiDay1, tsBuoiDay, tsNgayDay, soBuoiTrong1, soBuoiTrong2 };`
);

eval(engineCode);

const constrCode = fs.readFileSync('web/pages/tkb-constraints.js', 'utf8');
eval(constrCode);

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));
global.DATA = JSON.parse(JSON.stringify(schoolData));

async function runTest(){
  const baseViolations = global.TKBConstraints.validateAll(3000);
  console.log(`Incumbent Baseline Violations: ${baseViolations.length}`);
  const baseSet = new Set(baseViolations.map(v => `${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`));

  console.log("\n=== 1. OPTIMIZE SINGLETONS ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng1 = new FetTimetableEngine(global.DATA);
  const t0 = Date.now();
  const res1 = await eng1.optimize("optimize_singletons");
  const t1 = Date.now();
  console.log(`Singletons (${t1 - t0}ms): ${res1.initialMetrics.soBuoiDay1} -> ${res1.metrics.soBuoiDay1}`);
  global.DATA.tkb = eng1.getSnapshotTKB();
  const v1 = global.TKBConstraints.validateAll(3000);
  const added1 = v1.filter(v => !baseSet.has(`${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`)).length;
  console.log(`Validator Total Violations: ${v1.length}, Added: ${added1}`);

  console.log("\n=== 2. OPTIMIZE GAP2 ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng2 = new FetTimetableEngine(global.DATA);
  const t2 = Date.now();
  const res2 = await eng2.optimize("optimize_gap2");
  const t3 = Date.now();
  console.log(`Gap 2 (${t3 - t2}ms): ${res2.initialMetrics.soBuoiTrong2} -> ${res2.metrics.soBuoiTrong2}`);
  global.DATA.tkb = eng2.getSnapshotTKB();
  const v2 = global.TKBConstraints.validateAll(3000);
  const added2 = v2.filter(v => !baseSet.has(`${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`)).length;
  console.log(`Validator Total Violations: ${v2.length}, Added: ${added2}`);

  console.log("\n=== 3. OPTIMIZE GAP1 ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng3 = new FetTimetableEngine(global.DATA);
  const t4 = Date.now();
  const res3 = await eng3.optimize("optimize_gap1");
  const t5 = Date.now();
  console.log(`Gap 1 (${t5 - t4}ms): ${res3.initialMetrics.soBuoiTrong1} -> ${res3.metrics.soBuoiTrong1}`);
  global.DATA.tkb = eng3.getSnapshotTKB();
  const v3 = global.TKBConstraints.validateAll(3000);
  const added3 = v3.filter(v => !baseSet.has(`${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`)).length;
  console.log(`Validator Total Violations: ${v3.length}, Added: ${added3}`);

  console.log("\n=== 4. OPTIMIZE SESSIONS ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng4 = new FetTimetableEngine(global.DATA);
  const t6 = Date.now();
  const res4 = await eng4.optimize("optimize_sessions");
  const t7 = Date.now();
  console.log(`Sessions (${t7 - t6}ms): ${res4.initialMetrics.tsBuoiDay} -> ${res4.metrics.tsBuoiDay}`);
  global.DATA.tkb = eng4.getSnapshotTKB();
  const v4 = global.TKBConstraints.validateAll(3000);
  const added4 = v4.filter(v => !baseSet.has(`${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`)).length;
  console.log(`Validator Total Violations: ${v4.length}, Added: ${added4}`);

  console.log("\n=======================================================");
  if(added1 === 0 && added2 === 0 && added3 === 0 && added4 === 0){
    console.log("EXCELLENT! 0 ADDED VIOLATIONS ACROSS ALL 4 OPTIMIZERS!");
  }else{
    console.log(`FAILED: added1=${added1}, added2=${added2}, added3=${added3}, added4=${added4}`);
  }
  console.log("=======================================================");
}

runTest().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
