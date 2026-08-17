const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_fet_pair_first.js', 'utf8');
eval(engineCode.split('const artifactPath')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling solve() with 375 blocks first...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);
console.log("Lesson Block Violations:", engine.evaluateLessonBlockViolations());
console.log("Metrics:", engine.evaluateMetrics());
