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

// Multi-Stage Cascading Crusher
function multiStageCrusher(engine){
  const t0 = Date.now();
  let currentBest = engine.evaluateMetrics();

  for(let outer = 0; outer < 25; outer++){
    let outerImp = false;

    // Stage 1: Obliterate (2-way & 3-way Vacate)
    const m1 = engine.obliterateAllTeacherSingletons(15, Infinity);
    if(m1 && m1.soBuoiDay1 < currentBest.soBuoiDay1){
      currentBest = { ...m1 };
      outerImp = true;
    }

    // Stage 2: Consolidate (Same Teacher Same Class Merging)
    const m2 = engine.tryConsolidateTeacherSingletons(currentBest, currentBest, Infinity);
    if(m2 && m2.soBuoiDay1 < currentBest.soBuoiDay1){
      currentBest = { ...m2 };
      outerImp = true;
    }

    // Stage 3: Reinforce (Inbound Pull from >= 3 sessions)
    const m3 = engine.tryReinforceTeacherSingletons(currentBest, currentBest, Infinity);
    if(m3 && m3.soBuoiDay1 < currentBest.soBuoiDay1){
      currentBest = { ...m3 };
      outerImp = true;
    }

    console.log(`Outer pass ${outer+1}: singletons = ${currentBest.soBuoiDay1}, sessions = ${currentBest.tsBuoiDay}`);
    if(!outerImp && outer >= 3) break;
  }

  console.log(`Total time: ${Date.now() - t0}ms, Final:`, currentBest);
  return currentBest;
}

multiStageCrusher(opt);
