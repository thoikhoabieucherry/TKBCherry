const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.solve();

console.log("Total activities:", solver.activities.length);
console.log("Initial metrics:", solver.evaluateMetrics());

// Let's inspect which teachers have 1 period per session in current solution
const tGrid = solver.teacherGrid;
const singletonsByTeacher = new Map();

for(const [gv, grid] of tGrid.entries()){
  let count1 = 0;
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      let pCount = 0;
      for(let p = 0; p < 5; p++){
        if(grid[sStart + p] >= 0 || grid[sStart + p] === -3) pCount++;
      }
      if(pCount === 1) count1++;
    }
  }
  if(count1 > 0){
    singletonsByTeacher.set(gv, count1);
  }
}

console.log(`Teachers with singletons (${singletonsByTeacher.size} teachers):`);
for(const [gv, cnt] of singletonsByTeacher.entries()){
  // find total periods of this teacher
  const totalPeriods = solver.activities.filter(a => a.gv === gv).reduce((sum, a) => sum + a.duration, 0);
  console.log(`- ${gv}: ${cnt} singletons, Total periods: ${totalPeriods}`);
}
