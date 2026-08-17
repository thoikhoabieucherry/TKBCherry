const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
const snapTKB = solver.getSnapshotTKB();

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

// Compare solver grid with opt grid for every class
for(const lop of solver.classes){
  const cid = String(lop.id || "");
  const sGrid = solver.classGrid.get(cid);
  const oGrid = opt.classGrid.get(cid);

  for(let s = 0; s < 60; s++){
    const sVal = sGrid[s];
    const oVal = oGrid[s];
    if(sVal >= 0 && oVal < 0){
      const act = solver.activities[sVal];
      console.log(`Missing in opt at class ${cid} slot ${s}: actId ${sVal}, mon ${act?.mon}, gv ${act?.gv}`);
    }
  }
}
