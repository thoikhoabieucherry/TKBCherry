const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new FetTimetableEngine(schoolData);

console.log("Teacher keys sample:", Array.from(opt.teacherGrid.keys()).slice(0, 10));

// Find Linh
for(const [k, grid] of opt.teacherGrid.entries()){
  if(k.includes('Linh') || k.includes('linh')){
    console.log(`Found teacher key: ${k}`);
    for(let d = 0; d < 6; d++){
      const sang = [];
      const chieu = [];
      for(let p = 0; p < 5; p++){
        const actSang = grid[d * 10 + p];
        const actChieu = grid[d * 10 + 5 + p];
        if(actSang >= 0) sang.push(`P${p+1}:${opt.activities[actSang].classId}-${opt.activities[actSang].mon}`);
        if(actChieu >= 0) chieu.push(`P${p+1}:${opt.activities[actChieu].classId}-${opt.activities[actChieu].mon}`);
      }
      console.log(`Day ${d+2}: Sáng [${sang.join(', ')}] | Chiều [${chieu.join(', ')}]`);
    }
  }
}
