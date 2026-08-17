const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
const engineSource = fs.readFileSync(ENGINE_PATH, "utf8");
eval(engineSource);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101, optimizeHardCapMs: 30000 });
engine.loadExistingSchedule();

console.log("=== RUNNING ACTUAL ENGINE OPTIMIZE_SINGLETONS ===");
const initialM = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(initialM));

engine.optimize("optimize_singletons", (p) => {
  console.log(`[Progress ${p.percent}%] Metric: ${p.currentMetric} / ${p.initialMetric}`);
}).then(res => {
  console.log("\n=== OPTIMIZATION COMPLETED ===");
  console.log("Final Metrics:", JSON.stringify(res.metrics));
  console.log("Residual singletons:", JSON.stringify(res.residualSingletons));
  console.log("Placement Integrity OK:", engine.verifyPlacementIntegrity());
});
