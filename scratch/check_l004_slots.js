const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function test(){
  const solver = new FetTimetableEngine(schoolData);
  solver.solve();
  schoolData.tkb = solver.getSnapshotTKB();

  const opt = new FetTimetableEngine(schoolData);
  await opt.optimize("optimize_singletons");

  // Check class L004 on Day 2 Sáng and Day 7 Sáng
  const l004Grid = opt.classGrid.get("L004");
  console.log("Class L004 on Day 2 (d=0) Sáng:");
  for(let p = 0; p < 5; p++){
    const actId = l004Grid[p];
    const act = actId >= 0 ? opt.activities[actId] : null;
    console.log(`  P${p+1}: ${act ? `${act.mon} (${act.gv})` : 'EMPTY'}`);
  }

  console.log("Class L004 on Day 7 (d=5) Sáng:");
  for(let p = 0; p < 5; p++){
    const actId = l004Grid[50 + p];
    const act = actId >= 0 ? opt.activities[actId] : null;
    console.log(`  P${p+1}: ${act ? `${act.mon} (${act.gv})` : 'EMPTY'}`);
  }
}

test();
