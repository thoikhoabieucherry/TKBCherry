const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const engine = new FetTimetableEngine(schoolData);
engine.solve();

const snap = engine.getSnapshotTKB();
console.log("L028 (7A11) TKB schedule for Anh:");
const tkbL028 = snap['L028'];
for(const d of ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"]){
  console.log(`  ${d} sang:`, tkbL028[d]?.sang);
  console.log(`  ${d} chieu:`, tkbL028[d]?.chieu);
}

const acts = engine.activities.filter(a => a.classId === 'L028' && engine.getCanonMonKey(a.mon) === 'anh');
console.log("L028 activities for Anh:", acts);
