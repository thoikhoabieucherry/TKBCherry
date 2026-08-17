const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));
data.tkb = {}; // start from clean scratch

console.log("=== STEP 1: INITIAL SOLVE (XẾP BAN ĐẦU TỰ DO) ===");
const engine = new FetTimetableEngine(data, { seed: 101 });
const t0 = Date.now();
const solveRes = engine.solve();
console.log(`Solve done in ${Date.now() - t0}ms:`, solveRes);
const m0 = engine.evaluateMetrics();
console.log("Baseline metrics:", JSON.stringify(m0));
console.log("Integrity:", engine.verifyPlacementIntegrity());

console.log("\n=== STEP 2: OPTIMIZE SINGLETONS ===");
engine.optimize("optimize_singletons").then(res1 => {
  console.log("Singletons done. Metrics:", JSON.stringify(res1.metrics));

  console.log("\n=== STEP 3: OPTIMIZE GAP2 ===");
  engine.optimize("optimize_gap2").then(res2 => {
    console.log("Gap2 done. Metrics:", JSON.stringify(res2.metrics));
    console.log("Integrity OK:", engine.verifyPlacementIntegrity());
  });
});
