const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
let code = fs.readFileSync(ENGINE_PATH, "utf8");

// Fix existingActId !== act.id in line 1320
code = code.replace(/const existingActId = this\.classGrid\.get\(act\.classId\)\[s\];\s+if\(existingActId >= 0\)\{/, 'const existingActId = this.classGrid.get(act.classId)[s];\n          if(existingActId >= 0 && existingActId !== act.id){');

eval(code);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INITIAL METRICS ===");
const m0 = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m0));

console.log("\n=== RUNNING OPTIMIZE_GAP1 ===");
engine.optimize("optimize_gap1", (p) => {
  console.log(`[Progress ${p.percent}%] Gap1: ${p.currentMetric} / ${p.initialMetric}`);
}).then(res => {
  console.log("\n=== FINAL METRICS ===");
  console.log("Final Metrics:", JSON.stringify(res.metrics));
  console.log("Placement Integrity:", engine.verifyPlacementIntegrity());

  // Check 9/13 on Thu 5 chieu
  const act9_13 = engine.activities.find(a => a.classId === "9/13" && a.mon.includes("KHTN"));
  console.log("9/13 KHTN placement after:", engine.actPlacement[act9_13?.id]);
  const det = slotToDetails(engine.actPlacement[act9_13?.id]);
  console.log("9/13 KHTN details:", det);
});
