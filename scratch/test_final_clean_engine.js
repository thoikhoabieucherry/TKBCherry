const fs = require('fs');
const path = require('path');

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');
eval(engineCode);

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Running solve() on final web/pages/tkb-fet-engine.js...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);
console.log("Lesson Block Violations:", engine.evaluateLessonBlockViolations());
console.log("Metrics:", engine.evaluateMetrics());

if(res.ok && res.unassigned === 0 && engine.evaluateLessonBlockViolations() === 0){
  console.log("SUCCESS: 100% placed with 0 lesson block violations!");
}else{
  console.log("FAILURE: Conditions not met.");
  process.exit(1);
}
