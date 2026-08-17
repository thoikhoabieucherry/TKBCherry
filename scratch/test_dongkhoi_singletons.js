const fs = require('fs');

const dongkhoiData = JSON.parse(fs.readFileSync('scratch/dongkhoi_base_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const opt = new FetTimetableEngine(dongkhoiData);
opt.loadExistingSchedule();

console.log("Initial Dong Khoi metrics:", opt.evaluateMetrics());

opt.optimize("optimize_singletons").then(res => {
  console.log("Optimized Dong Khoi metrics:", res.metrics);
  console.log("Lesson block violations:", opt.evaluateLessonBlockViolations());
  console.log("Placed:", res.placed, "Unassigned:", res.unassigned);
});
