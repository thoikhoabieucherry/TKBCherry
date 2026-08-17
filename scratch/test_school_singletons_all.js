const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== METRICS BEFORE OPTIMIZATION ===");
const m0 = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m0));

console.log("\n=== RUNNING OPTIMIZE_SINGLETONS ===");
engine.optimize("optimize_singletons", (p) => {
  console.log(`[Progress ${p.percent}%] Singletons: ${p.currentMetric} / ${p.initialMetric}`);
}).then(res => {
  console.log("\n=== FINAL METRICS ===");
  console.log("Final Metrics:", JSON.stringify(res.metrics));
  console.log("Singletons count:", res.metrics.soBuoiDay1);
  console.log("Residual Singletons:", JSON.stringify(res.residualSingletons));
  console.log("Placement Integrity OK:", engine.verifyPlacementIntegrity());
});
