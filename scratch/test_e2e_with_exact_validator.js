const fs = require('fs');

global.window = global;
global.document = {
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {} }),
  head: { appendChild: () => {} },
  getElementById: () => null,
  querySelectorAll: () => [],
};

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const constrCode = fs.readFileSync('web/pages/tkb-constraints.js', 'utf8');
eval(constrCode);

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));
global.DATA = JSON.parse(JSON.stringify(schoolData));

async function runE2E(){
  console.log("=== 1. CHECK INCUMBENT BASELINE VIOLATIONS ===");
  const baseViolations = global.TKBConstraints.validateAll(3000);
  console.log(`Incumbent Baseline Violations: ${baseViolations.length}`);
  const baseMap = new Map();
  baseViolations.forEach(v => baseMap.set(`${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`, v));

  console.log("\n=== 2. TEST OPTIMIZE SINGLETONS ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng1 = new FetTimetableEngine(global.DATA);
  const res1 = await eng1.optimize("optimize_singletons");
  console.log(`Singletons: ${res1.initialMetrics.soBuoiDay1} -> ${res1.metrics.soBuoiDay1}`);
  global.DATA.tkb = eng1.getSnapshotTKB();
  const v1 = global.TKBConstraints.validateAll(3000);
  let added1 = 0;
  v1.forEach(v => {
    const k = `${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`;
    if(!baseMap.has(k)) added1++;
  });
  console.log(`Validator Total Violations: ${v1.length}, Added: ${added1}`);

  console.log("\n=== 3. TEST OPTIMIZE GAP2 ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng2 = new FetTimetableEngine(global.DATA);
  const res2 = await eng2.optimize("optimize_gap2");
  console.log(`Gap 2: ${res2.initialMetrics.soBuoiTrong2} -> ${res2.metrics.soBuoiTrong2}`);
  global.DATA.tkb = eng2.getSnapshotTKB();
  const v2 = global.TKBConstraints.validateAll(3000);
  let added2 = 0;
  v2.forEach(v => {
    const k = `${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`;
    if(!baseMap.has(k)) added2++;
  });
  console.log(`Validator Total Violations: ${v2.length}, Added: ${added2}`);

  console.log("\n=== 4. TEST OPTIMIZE GAP1 ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng3 = new FetTimetableEngine(global.DATA);
  const res3 = await eng3.optimize("optimize_gap1");
  console.log(`Gap 1: ${res3.initialMetrics.soBuoiTrong1} -> ${res3.metrics.soBuoiTrong1}`);
  global.DATA.tkb = eng3.getSnapshotTKB();
  const v3 = global.TKBConstraints.validateAll(3000);
  let added3 = 0;
  v3.forEach(v => {
    const k = `${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`;
    if(!baseMap.has(k)) added3++;
  });
  console.log(`Validator Total Violations: ${v3.length}, Added: ${added3}`);

  console.log("\n=== 5. TEST OPTIMIZE SESSIONS ===");
  global.DATA = JSON.parse(JSON.stringify(schoolData));
  const eng4 = new FetTimetableEngine(global.DATA);
  const res4 = await eng4.optimize("optimize_sessions");
  console.log(`Sessions: ${res4.initialMetrics.tsBuoiDay} -> ${res4.metrics.tsBuoiDay}`);
  global.DATA.tkb = eng4.getSnapshotTKB();
  const v4 = global.TKBConstraints.validateAll(3000);
  let added4 = 0;
  v4.forEach(v => {
    const k = `${v.kind || v.type}|${v.classId || ''}|${v.slot || ''}|${v.mon || ''}|${v.gv || ''}`;
    if(!baseMap.has(k)) added4++;
  });
  console.log(`Validator Total Violations: ${v4.length}, Added: ${added4}`);

  console.log("\n=======================================================");
  if(added1 === 0 && added2 === 0 && added3 === 0 && added4 === 0){
    console.log("SUCCESS: 0 ADDED VIOLATIONS ACROSS ALL OPTIMIZATION MODES!");
  }else{
    console.log(`FAILED: added1=${added1}, added2=${added2}, added3=${added3}, added4=${added4}`);
  }
  console.log("=======================================================");
}

runE2E().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
