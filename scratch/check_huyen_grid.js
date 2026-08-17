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

// Check T.Huyền
const huyenKey = Array.from(opt.teacherGrid.keys()).find(k => k.toLowerCase().includes('huyền'));
console.log("Teacher key:", huyenKey);

const tGrid = opt.teacherGrid.get(huyenKey);
console.log("T.Huyền grid before optimization:");
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
