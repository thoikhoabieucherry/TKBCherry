const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

console.log("Initial metrics:", opt.evaluateMetrics());

// Let's test a Simulated Annealing / Tabu / Ejection Chain optimizer for singletons:
function getTeacherSingletons(engine, tKey){
  const tGrid = engine.teacherGrid.get(tKey);
  if(!tGrid) return 0;
  let cnt = 0;
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      let taught = 0;
      for(let p = 0; p < 5; p++){
        if(tGrid[sStart + p] >= 0 || tGrid[sStart + p] === -3) taught++;
      }
      if(taught === 1) cnt++;
    }
  }
  return cnt;
}

// Compute singleton cost with heavy penalty on singletons
function computeSingletonEnergy(engine){
  const m = engine.evaluateMetrics();
  // Energy = soBuoiDay1 * 1000 + tsBuoiDay * 10 + soBuoiTrong2 * 5 + soBuoiTrong1;
  return m.soBuoiDay1 * 10000 + m.tsBuoiDay * 10 + m.soBuoiTrong2 * 5 + m.soBuoiTrong1;
}

console.log("Starting advanced optimization...");
const t0 = Date.now();

let currentEnergy = computeSingletonEnergy(opt);
let bestM = opt.evaluateMetrics();
console.log("Initial energy:", currentEnergy, bestM);

// Simulated Annealing + Tabu Search
const MAX_STEPS = 50000;
let temp = 50.0;
const cooling = 0.9997;

const tabuMap = new Map(); // key -> step

for(let step = 0; step < MAX_STEPS; step++){
  if(bestM.soBuoiDay1 <= 2) break; // Reached theoretical target!

  // Pick a random class
  const classIds = Array.from(opt.classGrid.keys());
  const cid = classIds[Math.floor(Math.random() * classIds.length)];
  const cGrid = opt.classGrid.get(cid);

  // Pick two different valid slots in cid
  const s1 = Math.floor(Math.random() * 60);
  const s2 = Math.floor(Math.random() * 60);
  if(s1 === s2) continue;
  if(opt.offSlots.has(`${cid}|${s1}`) || opt.offSlots.has(`${cid}|${s2}`)) continue;

  const actId1 = cGrid[s1];
  const actId2 = cGrid[s2];

  if(actId1 < 0 && actId2 < 0) continue;

  const act1 = actId1 >= 0 ? opt.activities[actId1] : null;
  const act2 = actId2 >= 0 ? opt.activities[actId2] : null;

  if(act1 && (act1.isFixed || act1.duration !== 1)) continue;
  if(act2 && (act2.isFixed || act2.duration !== 1)) continue;

  // Try swap
  if(act1) opt.unplaceActivity(act1.id);
  if(act2) opt.unplaceActivity(act2.id);

  let legal = true;
  if(act1){
    const r1 = opt.getConflictsForSlot(act1, s2);
    if(!r1.possible || r1.conflicts.length > 0) legal = false;
  }
  if(act2 && legal){
    const r2 = opt.getConflictsForSlot(act2, s1);
    if(!r2.possible || r2.conflicts.length > 0) legal = false;
  }

  if(!legal){
    if(act1) opt.placeActivityDirect(act1.id, s1);
    if(act2) opt.placeActivityDirect(act2.id, s2);
    continue;
  }

  if(act1) opt.placeActivityDirect(act1.id, s2);
  if(act2) opt.placeActivityDirect(act2.id, s1);

  if(!opt.isLessonBlockSafe(act1, act2)){
    if(act1) opt.unplaceActivity(act1.id);
    if(act2) opt.unplaceActivity(act2.id);
    if(act1) opt.placeActivityDirect(act1.id, s1);
    if(act2) opt.placeActivityDirect(act2.id, s2);
    continue;
  }

  const newEnergy = computeSingletonEnergy(opt);
  const delta = newEnergy - currentEnergy;

  if(delta < 0 || Math.exp(-delta / temp) > Math.random()){
    // Accept move
    currentEnergy = newEnergy;
    const newM = opt.evaluateMetrics();
    if(newM.soBuoiDay1 < bestM.soBuoiDay1){
      bestM = { ...newM };
      console.log(`[Step ${step}] Time ${Date.now() - t0}ms -> New best singletons: ${bestM.soBuoiDay1} (tsBuoiDay: ${bestM.tsBuoiDay}, gap2: ${bestM.soBuoiTrong2})`);
    }
  }else{
    // Revert move
    if(act1) opt.unplaceActivity(act1.id);
    if(act2) opt.unplaceActivity(act2.id);
    if(act1) opt.placeActivityDirect(act1.id, s1);
    if(act2) opt.placeActivityDirect(act2.id, s2);
  }

  temp *= cooling;
}

console.log(`\nOptimization finished in ${Date.now() - t0}ms:`, bestM);
