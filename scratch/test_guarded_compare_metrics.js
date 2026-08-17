const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
let code = fs.readFileSync(ENGINE_PATH, "utf8");

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

eval(code);
const FetTimetableEngine = global.FetTimetableEngine || global.window.FetTimetableEngine;

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

console.log("==================================================");
console.log("=== TESTING DUAL OPTIMIZATION PRESERVATION ===");
console.log("==================================================");

async function testBoth() {
  const engine = new FetTimetableEngine(data, { seed: 101 });
  engine.loadExistingSchedule();
  
  const m0 = engine.evaluateMetrics();
  console.log("Initial Metrics:", JSON.stringify(m0));
  
  console.log("\n1. Running optimize_gap2...");
  const resGap2 = await engine.optimize("optimize_gap2");
  console.log("Metrics after Gap2:", JSON.stringify(resGap2.metrics));
  
  console.log("\n2. Running optimize_singletons on top of Gap2 result...");
  const resSing = await engine.optimize("optimize_singletons");
  console.log("Metrics after Singletons:", JSON.stringify(resSing.metrics));
  
  console.log("\nFinal Verified Integrity:", engine.verifyPlacementIntegrity());
}

testBoth().catch(console.error);
