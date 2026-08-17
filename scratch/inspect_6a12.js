const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

const acts6A12 = engine.activities.filter(a => a.classCanon === '6A12' || a.classId === 'L012');
console.log(`Activities for 6A12 (${acts6A12.length}):`);
acts6A12.forEach(a => {
  const slot = engine.actPlacement[a.id];
  console.log(`  Act ${a.id}: mon=${a.mon}, dur=${a.duration}, slot=${slot}`);
});
