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

// Find T.Huy
const huyKey = Array.from(opt.teacherGrid.keys()).find(k => k.toLowerCase().includes('huy') && !k.toLowerCase().includes('huyền'));
console.log("Teacher T.Huy key:", huyKey);

// Run optimize_singletons
opt.optimize('optimize_singletons').then(() => {
  console.log("\nAfter optimize_singletons:", opt.evaluateMetrics());

  // Check T.Huy grid
  const tGrid = opt.teacherGrid.get(huyKey);
  console.log(`\nTeacher ${huyKey} schedule:`);
  for(let d = 0; d < 6; d++){
    const sang = [];
    const chieu = [];
    for(let p = 0; p < 5; p++){
      const s1 = d * 10 + p;
      const s2 = d * 10 + 5 + p;
      if(tGrid[s1] >= 0){
        const a = opt.activities[tGrid[s1]];
        sang.push(`P${p+1}:${a.classId}-${a.mon}`);
      }
      if(tGrid[s2] >= 0){
        const a = opt.activities[tGrid[s2]];
        chieu.push(`P${p+1}:${a.classId}-${a.mon}`);
      }
    }
    console.log(`Day ${d+2}: Sáng [${sang.join(', ')}] | Chiều [${chieu.join(', ')}]`);
  }

  // Find all remaining singletons
  const remaining = [];
  for(const [gv, grid] of opt.teacherGrid.entries()){
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const taught = [];
        for(let p = 0; p < 5; p++){
          const s = sStart + p;
          if(grid[s] >= 0 || grid[s] === -3){
            taught.push({ p, slot: s, actId: grid[s] });
          }
        }
        if(taught.length === 1){
          const act = taught[0].actId >= 0 ? opt.activities[taught[0].actId] : null;
          remaining.push({
            gv, day: d, session: b, slot: taught[0].slot, actId: taught[0].actId,
            classId: act?.classId, mon: act?.mon, duration: act?.duration
          });
        }
      }
    }
  }

  console.log(`\nTotal remaining singletons: ${remaining.length}`);
  for(const s of remaining){
    console.log(`- Teacher ${s.gv}: Day ${s.day+2} (${s.session===0?'Sáng':'Chiều'}), Slot ${s.slot}, Class ${s.classId}, Mon ${s.mon}, Dur ${s.duration}`);
  }
});
