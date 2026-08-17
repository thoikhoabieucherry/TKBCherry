const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101, optimizeHardCapMs: 30000 });
engine.loadExistingSchedule();

console.log("=== RUNNING OPTIMIZE_GAP2 ===");
const initialM = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(initialM));

engine.optimize("optimize_gap2", (p) => {
  console.log(`[Progress ${p.percent}%] Gap2: ${p.currentMetric} / ${p.initialMetric}`);
}).then(res => {
  console.log("\n=== GAP2 OPTIMIZATION COMPLETED ===");
  console.log("Final Metrics:", JSON.stringify(res.metrics));
  console.log("Residual gap2 sessions:", JSON.stringify(res.residualGap2));
  console.log("Placement Integrity OK:", engine.verifyPlacementIntegrity());
});
