const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

console.log("=== Debugging verifyPlacementIntegrity & saveBestSnapshot ===");
console.log("Initial placed baseline:", solver.activities.filter(a => solver.actPlacement[a.id] >= 0).reduce((acc, a) => acc + a.duration, 0));
console.log("Initial student holes:", solver.countStudentHoles());

const initM = solver.evaluateMetrics();
console.log("Initial metrics:", initM);

const fastM = solver.tryFastSingletonRepair(initM, initM);
console.log("After fast repair metrics:", solver.evaluateMetrics());
console.log("Placed count after fast repair:", solver.activities.filter(a => solver.actPlacement[a.id] >= 0).reduce((acc, a) => acc + a.duration, 0));
console.log("Student holes after fast repair:", solver.countStudentHoles());
console.log("verifyPlacementIntegrity after fast repair:", solver.verifyPlacementIntegrity());
console.log("compareMetrics(after, initial):", solver.compareMetrics(solver.evaluateMetrics(), initM, "optimize_singletons"));
