const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

console.log("=== Profiling full optimize_singletons pipeline ===");

const t0 = Date.now();
solver.optimize("optimize_singletons", (p) => {
  console.log(`[${Date.now() - t0}ms] Progress: ${p.percent}% - Metric: ${p.currentMetric}`);
}).then(res => {
  console.log(`\nCompleted in ${Date.now() - t0}ms!`, res);
});
