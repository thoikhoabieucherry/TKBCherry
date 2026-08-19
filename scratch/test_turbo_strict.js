const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

console.log("=== Testing Strict Turbo Engine ===");
console.log("Initial Metrics:", solver.evaluateMetrics());

// Let's test tryFastSingletonRepair with strict candM check
const initM = solver.evaluateMetrics();
const t0 = Date.now();
const fastM = solver.tryFastSingletonRepair(initM, initM, (m) => {
  console.log(`[${Date.now() - t0}ms] Progress: Singletons = ${m.soBuoiDay1}`);
});
const t1 = Date.now();

console.log(`Completed in ${t1 - t0}ms!`);
console.log("Final Metrics:", solver.evaluateMetrics());
console.log("Compare with initial:", solver.compareMetrics(solver.evaluateMetrics(), initM, "optimize_singletons"));
