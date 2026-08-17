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
console.log('0. After loadExistingSchedule violations:', opt.evaluateLessonBlockViolations());

opt.obliterateAllTeacherSingletons(15, Infinity);
console.log('1. After obliterateAllTeacherSingletons violations:', opt.evaluateLessonBlockViolations());

opt.tryConsolidateTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);
console.log('2. After tryConsolidateTeacherSingletons violations:', opt.evaluateLessonBlockViolations());

opt.tryReinforceTeacherSingletons(opt.evaluateMetrics(), opt.evaluateMetrics(), Infinity);
console.log('3. After tryReinforceTeacherSingletons violations:', opt.evaluateLessonBlockViolations());

opt.tryCrushTeacherGaps(opt.evaluateMetrics(), opt.evaluateMetrics(), 'optimize_gap2');
console.log('4. After tryCrushTeacherGaps violations:', opt.evaluateLessonBlockViolations());
