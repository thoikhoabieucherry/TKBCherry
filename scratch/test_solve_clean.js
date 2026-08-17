const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
let code = fs.readFileSync(ENGINE_PATH, "utf8");

// Modify getPlacementPenalty to return 0 in solve mode
code = code.replace(/getPlacementPenalty\(act, slot\)\{/, 'getPlacementPenalty(act, slot){\n      if(!this.isOptimizeMode) return 0;');
code = code.replace(/this\.strictFetGaps = true;/, 'this.strictFetGaps = false;');

eval(code);

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));
// Clear tkb so solve() builds from scratch
data.tkb = {};

const engine = new FetTimetableEngine(data, { seed: 101 });
console.log("=== RUNNING CLEAN INITIAL SOLVE ===");
const t0 = Date.now();
const res = engine.solve((p) => {
  if (p.percent % 20 === 0) console.log(`[Solve ${p.percent}%] Placed: ${p.placed} / ${p.total}`);
});

console.log(`\nSolve completed in ${Date.now() - t0}ms:`, res);
console.log("Placement Integrity OK:", engine.verifyPlacementIntegrity());

const metrics = engine.evaluateMetrics();
console.log("Constructed Timetable Metrics:", JSON.stringify(metrics));
