const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
let code = fs.readFileSync(ENGINE_PATH, "utf8");

// Override restartTargetVal and singleton exit target to 0
code = code.replace(/const restartTargetVal = \(mode === "optimize_singletons" && !this\.pushToZero\) \? 2 : 0;/, 'const restartTargetVal = 0;');
code = code.replace(/if\(mode === "optimize_singletons" && bestMetrics\.soBuoiDay1 <= \(this\.pushToZero \? 0 : 2\)\)/, 'if(mode === "optimize_singletons" && bestMetrics.soBuoiDay1 <= 0)');

eval(code);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101, optimizeHardCapMs: 30000 });
engine.loadExistingSchedule();

console.log("=== INITIAL METRICS ===");
const initialM = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(initialM));

console.log("\n=== RUNNING OPTIMIZE_SINGLETONS WITH TARGET 0 ===");
engine.optimize("optimize_singletons", (p) => {
  console.log(`[Progress ${p.percent}%] Singletons: ${p.currentMetric} / ${p.initialMetric}`);
}).then(res => {
  console.log("\n=== OPTIMIZATION RESULT ===");
  console.log("Final Metrics:", JSON.stringify(res.metrics));
  console.log("Residual singletons:", JSON.stringify(res.residualSingletons));
  console.log("Placement Integrity OK:", engine.verifyPlacementIntegrity());
});
