const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

async function checkSingletons(){
  const solver = new FetTimetableEngine(schoolData);
  solver.loadExistingSchedule();
  
  const res = await solver.optimize("optimize_singletons");
  console.log("Optimized metrics:", res.metrics);
  console.log("Residual singletons:", res.residualSingletons);
}

checkSingletons();
