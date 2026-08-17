const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_fet_pair_first.js', 'utf8');
eval(engineCode.split('const artifactPath')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.init();

console.log("Class L001 initial activities with duration:");
const l001Acts = engine.activities.filter(a => a.classId === 'L001');
l001Acts.forEach(a => {
  console.log(`  id: ${a.id}, mon: "${a.mon}", gv: "${a.gv}", dur: ${a.duration}`);
});
