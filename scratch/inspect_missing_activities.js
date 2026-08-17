const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.init();

console.log("Total activities created in init():", engine.activities.length);
let totalLessonsInActs = engine.activities.reduce((sum, a) => sum + a.duration, 0);
console.log("Total lesson periods in activities:", totalLessonsInActs);

// Check L034, L051, L064, L072
for(const targetCid of ['L034', 'L051', 'L064', 'L072']){
  const acts = engine.activities.filter(a => a.classId === targetCid);
  const totalInClass = acts.reduce((sum, a) => sum + a.duration, 0);
  console.log(`\nClass ${targetCid} total periods in activities: ${totalInClass}`);
  acts.forEach(a => console.log(`  Act: mon=${a.mon}, dur=${a.duration}, gv=${a.gv}`));
  
  // Check fixed cells for this class
  for(let s = 0; s < 60; s++){
    const fix = engine.fixedSlots.get(`${targetCid}|${s}`);
    if(fix) console.log(`  Fixed slot ${s}:`, fix);
  }
}
