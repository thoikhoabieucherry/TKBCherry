const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

// Mock window and D() for tkb-constraints.js
global.window = global;
global.document = { querySelector: () => null, querySelectorAll: () => [] };
global.localStorage = { getItem: () => null, setItem: () => {} };

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));
global.DATA = data;
global.D = () => global.DATA;

// Load constraints
const CONSTRAINTS_PATH = path.resolve(__dirname, "../web/pages/tkb-constraints.js");
try {
  eval(fs.readFileSync(CONSTRAINTS_PATH, "utf8"));
} catch(e) {
  console.log("Error loading constraints script:", e.message);
}

const engine = new FetTimetableEngine(data, { seed: 101, optimizeHardCapMs: 30000 });
engine.loadExistingSchedule();

console.log("=== RUNNING OPTIMIZE_SINGLETONS ===");
const initialM = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(initialM));

engine.optimize("optimize_singletons").then(res => {
  console.log("Optimization done. Metrics:", JSON.stringify(res.metrics));
  engine.applyToDataTKB();

  if(global.TKBConstraints && typeof global.TKBConstraints.validateAll === "function"){
    const violations = global.TKBConstraints.validateAll(100);
    console.log(`\n=== TKBConstraints.validateAll results (${violations.length} violations) ===`);
    violations.slice(0, 10).forEach((v, i) => {
      console.log(`[${i+1}] ${v.className || v.lopId} - ${v.mon} (${v.thu} ${v.buoi} T${v.ti}): ${v.message || v.kind}`);
    });
  } else {
    console.log("TKBConstraints.validateAll not available in node mock.");
  }
});
