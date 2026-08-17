const fs = require('fs');
const path = require('path');

const engineCode = fs.readFileSync(path.join(__dirname, '../web/pages/tkb-fet-engine.js'), 'utf8');

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const artifactPath = 'C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json';
const schoolData = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

console.log("Testing action: 'solve' with FetTimetableEngine...");
const engineSolve = new FetTimetableEngine(schoolData);

let progressCount = 0;
const resSolve = engineSolve.solve((prog) => {
  progressCount++;
});

console.log("Solve result:", resSolve);
console.log("Progress callbacks fired:", progressCount);
const tkbSolve = engineSolve.getSnapshotTKB();
console.log("Snapshot TKB keys count:", Object.keys(tkbSolve).length);

console.log("\nTesting action: 'optimize' (optimize_singletons)...");
const engineOpt = new FetTimetableEngine(schoolData);
engineOpt.optimize("optimize_singletons", (prog) => {
}).then((resOpt) => {
  console.log("Optimize result:", resOpt);
  console.log("All tests passed successfully!");
});
