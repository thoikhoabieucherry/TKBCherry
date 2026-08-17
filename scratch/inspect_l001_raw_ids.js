const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_no_decomp.js', 'utf8');
eval(engineCode.split('const schoolData')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.solve();

const cGrid = engine.classGrid.get('L001');
console.log("L001 cGrid raw actIds:");
for(let s = 0; s < 60; s++){
  const actId = cGrid[s];
  if(actId >= 0){
    const a = engine.activities[actId];
    console.log(`  slot ${s} (day ${Math.floor(s/10)}, buoi ${Math.floor((s%10)/5)}, p ${(s%10)%5}): actId=${actId}, mon=${a.mon}, classId=${a.classId}, dur=${a.duration}`);
  }
}
