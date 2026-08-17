const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

const opt = new globalThis.FetTimetableEngine(schoolData);
opt.loadExistingSchedule();

console.log("Sample activities classIds:", opt.activities.slice(0, 5).map(a => ({ id: a.id, cid: a.classId, classCanon: a.classCanon })));

console.log("Sample classSubjectLessonBlocks keys & reqs:", Array.from(opt.classSubjectLessonBlocks.entries()).slice(0, 5));
