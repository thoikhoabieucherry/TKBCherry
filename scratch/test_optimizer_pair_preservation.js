const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

// 1. Solve initial schedule
const solver = new FetTimetableEngine(schoolData);
solver.solve();
schoolData.tkb = solver.getSnapshotTKB();

console.log("Initial schedule lesson block violations:", solver.evaluateLessonBlockViolations());
console.log("Initial schedule metrics:", solver.evaluateMetrics());

// 2. Run optimize on this schedule
const optimizer = new FetTimetableEngine(schoolData);
optimizer.loadExistingSchedule();

console.log("Loaded activities count:", optimizer.activities.length);
const dur2Acts = optimizer.activities.filter(a => a.duration === 2);
console.log("Duration 2 activities in loaded schedule:", dur2Acts.length);

// Let's test running optimize('optimize_singletons')
console.log("\nRunning optimizer.optimize('optimize_singletons')...");
optimizer.optimize('optimize_singletons').then(res => {
  console.log("Optimize result:", res);
  console.log("Post-optimize lesson block violations:", optimizer.evaluateLessonBlockViolations());
  console.log("Post-optimize metrics:", optimizer.evaluateMetrics());
});
