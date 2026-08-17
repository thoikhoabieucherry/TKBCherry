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
  const m = opt.evaluateMetrics();
  console.log("After primary optimize:", m);

  // Find remaining singletons
  const remaining = [];
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
          remaining.push({ gv, day: d, session: b, slot: taught[0].slot, act });
        }
      }
    }
  }

  console.log(`\nRemaining singletons (${remaining.length}):`);
  for(const s of remaining){
    // Calculate total load of this teacher in this session across the week
    let totalInShift = 0;
    const tGrid = opt.teacherGrid.get(s.gv);
    for(let d = 0; d < 6; d++){
      for(let p = 0; p < 5; p++){
        const ss = d * 10 + s.session * 5 + p;
        if(tGrid[ss] >= 0 || tGrid[ss] === -3) totalInShift++;
      }
    }
    console.log(`- Teacher ${s.gv}: Day ${s.day+2} (${s.session===0?'Sáng':'Chiều'}), Class ${s.act.classId}, Mon ${s.act.mon}, Total in this shift across week: ${totalInShift}`);
  }
});
