const fs = require('fs');
const path = require('path');

let engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

// Set strictFetGaps = false in solve() initial pass
engineCode = engineCode.replace(
  `    solve(progressCallback = null){\n      this.init();\n      this.strictFetGaps = true;`,
  `    solve(progressCallback = null){\n      this.init();\n      this.strictFetGaps = false;`
);

eval(engineCode);

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);

console.log("Calling solve() with soft gaps initial...");
const t0 = Date.now();
const res = engine.solve();
const t1 = Date.now();

console.log(`Solve finished in ${t1 - t0}ms:`, res);
console.log("LB Violations:", engine.evaluateLessonBlockViolations());
console.log("Metrics:", engine.evaluateMetrics());
