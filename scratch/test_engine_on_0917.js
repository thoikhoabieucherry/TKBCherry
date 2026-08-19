const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testSingletons(){
  console.log("=== Testing FetTimetableEngine optimize_singletons ===");
  const solver = new FetTimetableEngine(schoolData);
  solver.loadExistingSchedule();
  const initialM = solver.evaluateMetrics();
  console.log("Initial metrics:", initialM);

  const res = await solver.optimize("optimize_singletons", (p) => {
    if(p.percent % 20 === 0) console.log(`Progress: ${p.percent}% - Current singletons: ${p.currentMetric}`);
  });

  console.log("\nOptimized metrics:", res.metrics);
  console.log("Placed:", res.placed);
}

testSingletons();
