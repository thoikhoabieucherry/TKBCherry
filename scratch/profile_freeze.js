const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

console.log("=== Profiling 4-Way loop time ===");
const t0 = Date.now();
solver.tryFastSingletonRepair();
const t1 = Date.now();
console.log(`tryFastSingletonRepair took: ${t1 - t0}ms`);
