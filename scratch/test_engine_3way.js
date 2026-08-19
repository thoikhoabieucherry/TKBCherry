const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function testEngineWith3Way(){
  console.log("=== Testing FetTimetableEngine with 3-Way Cycle Swap ===");
  const solver = new FetTimetableEngine(schoolData);
  solver.loadExistingSchedule();
  
  const initM = solver.evaluateMetrics();
  console.log("Initial Metrics:", initM);

  const t0 = Date.now();
  const fastM = solver.tryFastSingletonRepair(initM, initM, (m) => {
    console.log(`[${Date.now() - t0}ms] Fast Repair Progress: Singletons = ${m.soBuoiDay1}`);
  });
  const t1 = Date.now();

  console.log(`\nFast repair completed in ${t1 - t0}ms!`);
  console.log("fastM:", fastM);
  console.log("Final solver metrics:", solver.evaluateMetrics());
  console.log("Integrity verified:", solver.verifyPlacementIntegrity());
  console.log("Student holes:", solver.countStudentHoles());
}

testEngineWith3Way();
