const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

// Unplace 1 random activity to simulate Chưa xếp = 1
const actToUnplace = solver.activities.find(a => solver.actPlacement[a.id] >= 0 && !a.isFixed);
console.log("Unplacing activity:", actToUnplace.id, actToUnplace.subject, actToUnplace.classId);
solver.jrnUnplace(actToUnplace.id);

console.log("Placed count:", solver.activities.filter(a => solver.actPlacement[a.id] >= 0).reduce((acc, a) => acc + a.duration, 0));
console.log("Student holes:", solver.countStudentHoles());
console.log("Metrics before optimize:", solver.evaluateMetrics());

solver.optimize("optimize_singletons", (p) => {
  console.log(`Progress: ${p.percent}% - Metric: ${p.currentMetric}`);
}).then(res => {
  console.log("\nResult:", res);
  console.log("Final metrics:", solver.evaluateMetrics());
});
