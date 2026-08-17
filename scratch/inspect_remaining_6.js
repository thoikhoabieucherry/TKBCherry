const fs = require('fs');
const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

opt.optimize('optimize_singletons').then(res => {
  console.log('Optimized Metrics:', res.metrics);
  
  // Inspect all teachers with 1-period sessions
  opt.teacherGrid.forEach((grid, tKey) => {
    if (!tKey) return;
    for (let d = 0; d < 6; d++) {
      for (let b = 0; b < 2; b++) {
        const sStart = d * 10 + b * 5;
        const taught = [];
        for (let p = 0; p < 5; p++) {
          const s = sStart + p;
          if (grid[s] >= 0 || grid[s] === -3) {
            taught.push({ slot: s, val: grid[s] });
          }
        }
        if (taught.length === 1) {
          const item = taught[0];
          const act = item.val >= 0 ? opt.activities[item.val] : null;
          console.log(`Teacher [${tKey}] at Thu ${d+2} ${b===0?'Sang':'Chieu'}: slot ${item.slot}, actId: ${item.val}, mon: ${act?.mon}, isFixed: ${act?.isFixed || item.val===-3}, classId: ${act?.classId}`);
          
          // Check teacher's total periods in the entire week
          let totalWeekly = 0;
          for (let s = 0; s < 60; s++) if (grid[s] >= 0 || grid[s] === -3) totalWeekly++;
          console.log(`  -> Total weekly periods for ${tKey}: ${totalWeekly}`);
        }
      }
    }
  });
});
