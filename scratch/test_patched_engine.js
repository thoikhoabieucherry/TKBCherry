const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testOptimizedEngine(){
  console.log("=== Testing Patched FetTimetableEngine (Direction 1) ===");
  const solver = new FetTimetableEngine(schoolData);
  solver.loadExistingSchedule();
  
  const initialM = solver.evaluateMetrics();
  console.log("Initial metrics:", initialM);

  const t0 = Date.now();
  const res = await solver.optimize("optimize_singletons", (p) => {
    console.log(`[${Date.now() - t0}ms] Progress: ${p.percent}% - Singletons: ${p.currentMetric}`);
  });
  const t1 = Date.now();

  console.log(`\nCompleted in ${t1 - t0}ms!`);
  console.log("Final metrics:", res.metrics);
  console.log("Residual singletons:", res.residualSingletons);
  console.log("Integrity verified:", solver.verifyPlacementIntegrity());
}

testOptimizedEngine();
