const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

console.log("==================================================");
console.log("=== EVALUATING NEWLY EXPORTED TIMETABLE ===");
console.log("==================================================");

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

const m0 = engine.evaluateMetrics();
console.log("Baseline Initial Metrics:", JSON.stringify(m0, null, 2));

console.log("\nPlacement Integrity at Start:", engine.verifyPlacementIntegrity());

async function runEvaluations() {
  console.log("\n--------------------------------------------------");
  console.log("--- TEST 1: OPTIMIZE 2 TIẾT TRỐNG (optimize_gap2) ---");
  console.log("--------------------------------------------------");
  
  // Clone engine state for test 1
  const eng1 = new FetTimetableEngine(data, { seed: 101 });
  eng1.loadExistingSchedule();
  
  const t0_gap2 = Date.now();
  const res_gap2 = await eng1.optimize("optimize_gap2", (p) => {
    if (p.percent % 10 === 0 || p.currentMetric === 0) {
      console.log(`[Gap2 Progress ${p.percent}%] Gap2: ${p.currentMetric} / ${p.initialMetric}`);
    }
  });
  console.log(`Gap2 Optimization finished in ${Date.now() - t0_gap2}ms:`);
  console.log("Final Metrics:", JSON.stringify(res_gap2.metrics, null, 2));
  console.log("Residual Gap2 Sessions:", JSON.stringify(res_gap2.residualGap2));
  console.log("Placement Integrity OK:", eng1.verifyPlacementIntegrity());

  console.log("\n--------------------------------------------------");
  console.log("--- TEST 2: OPTIMIZE 1 TIẾT/BUỔI (optimize_singletons) ---");
  console.log("--------------------------------------------------");
  
  // Clone engine state for test 2
  const eng2 = new FetTimetableEngine(data, { seed: 101 });
  eng2.loadExistingSchedule();
  
  const t0_sing = Date.now();
  const res_sing = await eng2.optimize("optimize_singletons", (p) => {
    if (p.percent % 10 === 0 || p.currentMetric <= 2) {
      console.log(`[Singletons Progress ${p.percent}%] Singletons: ${p.currentMetric} / ${p.initialMetric}`);
    }
  });
  console.log(`Singletons Optimization finished in ${Date.now() - t0_sing}ms:`);
  console.log("Final Metrics:", JSON.stringify(res_sing.metrics, null, 2));
  console.log("Residual Singletons:", JSON.stringify(res_sing.residualSingletons, null, 2));
  console.log("Placement Integrity OK:", eng2.verifyPlacementIntegrity());
}

runEvaluations().catch(console.error);
