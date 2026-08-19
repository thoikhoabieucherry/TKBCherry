const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const solver = new FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

const initM = solver.evaluateMetrics();
console.log("Initial Metrics:", initM);

const fastM = solver.tryFastSingletonRepair(initM, initM, (m) => {
  console.log("Progress callback in fast repair:", m.soBuoiDay1);
});

console.log("\nfastM returned:", fastM);
console.log("Metrics after fast repair:", solver.evaluateMetrics());
