const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testBoth(){
  console.log("=== 1. Testing optimize_singletons ===");
  const s1 = new FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  s1.loadExistingSchedule();
  console.log("Initial s1:", s1.evaluateMetrics());
  const res1 = await s1.optimize("optimize_singletons", (p) => {
    console.log(`[Singletons] ${p.percent}% - Metric: ${p.currentMetric}`);
  });
  console.log("Result s1:", res1.metrics);

  console.log("\n=== 2. Testing optimize_gap2 ===");
  const s2 = new FetTimetableEngine(JSON.parse(JSON.stringify(schoolData)));
  s2.loadExistingSchedule();
  console.log("Initial s2:", s2.evaluateMetrics());
  const res2 = await s2.optimizeGap2WithBorrow((p) => {
    console.log(`[Gap2] ${p.percent}% - Metric: ${p.currentMetric}`);
  });
  console.log("Result s2:", res2.metrics);
}

testBoth();
