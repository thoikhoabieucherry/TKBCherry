const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

console.log("Initial metrics:", opt.evaluateMetrics());

// Let's run optimize_singletons for multiple passes
async function runDeepOptimizer(engine){
  const t0 = Date.now();
  let bestM = engine.evaluateMetrics();

  for(let pass = 0; pass < 20; pass++){
    const m = await engine.optimize('optimize_singletons');
    console.log(`Pass ${pass+1}: singletons = ${m.metrics.soBuoiDay1}, sessions = ${m.metrics.tsBuoiDay}`);
    if(m.metrics.soBuoiDay1 <= 2) break;
  }

  console.log(`Deep optimizer completed in ${Date.now() - t0}ms:`, engine.evaluateMetrics());
}

runDeepOptimizer(opt);
