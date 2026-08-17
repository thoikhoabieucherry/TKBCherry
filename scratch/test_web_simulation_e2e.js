const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");

// Mock browser environment
global.window = {
  __TKB_GLOBAL_DATA_VERSION: 1
};
global.document = {};
global.localStorage = {
  getItem: () => null,
  setItem: () => {}
};
global.fetch = async () => ({ ok: true, json: async () => ({}) });

eval(fs.readFileSync(ENGINE_PATH, "utf8"));
const FetTimetableEngine = global.FetTimetableEngine || global.window.FetTimetableEngine;

// Load data
const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

console.log("==================================================");
console.log("=== SIMULATING EXACT BROWSER / WEB WORKER FLOW ===");
console.log("==================================================");

async function simulateWebFlow() {
  // Test 1: Clicking "Tối ưu 2 tiết trống"
  console.log("\n>>> ACTION 1: User clicks 'Tối ưu 2 tiết trống' (optimize_gap2) <<<");
  const engine1 = new FetTimetableEngine(data, { seed: 101 });
  engine1.loadExistingSchedule();
  
  const m0_gap2 = engine1.evaluateMetrics();
  console.log("Initial Stats before click:", JSON.stringify(m0_gap2));
  
  const res1 = await engine1.optimize("optimize_gap2", (p) => {
    // progress
  });
  
  console.log(`Optimization returned: ok=${res1.ok}, soBuoiTrong2: ${m0_gap2.soBuoiTrong2} -> ${res1.metrics.soBuoiTrong2}`);
  console.log("Full metrics after gap2:", JSON.stringify(res1.metrics));

  // Test 2: Clicking "Tối ưu 1 tiết/buổi"
  console.log("\n>>> ACTION 2: User clicks 'Tối ưu 1 tiết/buổi' (optimize_singletons) <<<");
  const engine2 = new FetTimetableEngine(data, { seed: 101 });
  engine2.loadExistingSchedule();
  
  const m0_sing = engine2.evaluateMetrics();
  console.log("Initial Stats before click:", JSON.stringify(m0_sing));
  
  const res2 = await engine2.optimize("optimize_singletons", (p) => {
    // progress
  });
  
  console.log(`Optimization returned: ok=${res2.ok}, soBuoiDay1: ${m0_sing.soBuoiDay1} -> ${res2.metrics.soBuoiDay1}`);
  console.log("Full metrics after singletons:", JSON.stringify(res2.metrics));
  
  // Test 3: Can we achieve BOTH soBuoiTrong2 === 0 AND soBuoiDay1 <= 2 simultaneously?
  console.log("\n>>> ACTION 3: Achieving BOTH soBuoiTrong2 === 0 AND soBuoiDay1 <= 2 simultaneously <<<");
  const engine3 = new FetTimetableEngine(data, { seed: 101 });
  engine3.loadExistingSchedule();
  
  // Step 3a: Run optimize_singletons
  await engine3.optimize("optimize_singletons");
  console.log("After singletons:", JSON.stringify(engine3.evaluateMetrics()));
  
  // Step 3b: Run optimize_gap2
  await engine3.optimize("optimize_gap2");
  console.log("After gap2:", JSON.stringify(engine3.evaluateMetrics()));
  
  // Step 3c: Run optimize_singletons again
  await engine3.optimize("optimize_singletons");
  const mFinal = engine3.evaluateMetrics();
  console.log("After re-singletons:", JSON.stringify(mFinal));
  console.log(`Final Result: soBuoiTrong2 = ${mFinal.soBuoiTrong2}, soBuoiDay1 = ${mFinal.soBuoiDay1}`);
}

simulateWebFlow().catch(console.error);
