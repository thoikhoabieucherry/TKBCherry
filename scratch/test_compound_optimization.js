const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

console.log("==================================================");
console.log("=== COMPOUND SEQUENTIAL OPTIMIZATION TEST ===");
console.log("==================================================");

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("Initial Metrics:", JSON.stringify(engine.evaluateMetrics(), null, 2));

async function runPipeline() {
  console.log("\n>>> STAGE 1: optimize_singletons (Tối ưu 1 tiết/buổi) <<<");
  const res1 = await engine.optimize("optimize_singletons", p => {
    if (p.percent === 100 || p.currentMetric <= 2) console.log(`[Stage 1] Singletons: ${p.currentMetric}`);
  });
  console.log("Stage 1 result:", JSON.stringify(res1.metrics));

  console.log("\n>>> STAGE 2: optimize_gap2 (Tối ưu 2 tiết trống) <<<");
  const res2 = await engine.optimize("optimize_gap2", p => {
    if (p.percent === 100 || p.currentMetric === 0) console.log(`[Stage 2] Gap2: ${p.currentMetric}`);
  });
  console.log("Stage 2 result:", JSON.stringify(res2.metrics));

  console.log("\n>>> STAGE 3: optimize_singletons AGAIN (Re-optimizing singletons if any were created) <<<");
  const res3 = await engine.optimize("optimize_singletons", p => {
    if (p.percent === 100 || p.currentMetric <= 2) console.log(`[Stage 3] Singletons: ${p.currentMetric}`);
  });
  console.log("Stage 3 result:", JSON.stringify(res3.metrics));

  console.log("\nFinal Placement Integrity:", engine.verifyPlacementIntegrity());
}

runPipeline().catch(console.error);
