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

opt.optimize('optimize_singletons').then(() => {
  console.log("Final metrics:", opt.evaluateMetrics());

  // Find remaining singletons
  for(const [gv, grid] of opt.teacherGrid.entries()){
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const taught = [];
        for(let p = 0; p < 5; p++){
          const s = sStart + p;
          if(grid[s] >= 0 || grid[s] === -3) taught.push({ p, slot: s, actId: grid[s] });
        }
        if(taught.length === 1 && taught[0].actId >= 0){
          const act = opt.activities[taught[0].actId];
          console.log(`- Teacher ${gv}: Day ${d+2} (${b===0?'Sáng':'Chiều'}), Class ${act.classId}, Mon ${act.mon}`);
        }
      }
    }
  }
});
