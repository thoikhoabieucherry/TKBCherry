const fs = require('fs');
const path = require('path');

// 1. Load engine
const enginePath = "C:/Users/Love/Documents/Codex/MD/tkb-fet-engine.js";
const engineCode = fs.readFileSync(enginePath, 'utf8');
eval(engineCode);

// 2. Load data
const dataPath = "C:/Users/Love/Documents/Codex/temp/data_tonggv05.json";
const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

async function testEngine() {
  console.log("=== INITIALIZING FET ENGINE ===");
  const options = {
    uiBreathingMs: 0,
    gap2SessionBudget: 0,
    optimizeRestartBudgetMs: 30000
  };
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();

  const initM = engine.evaluateMetrics();
  console.log("Initial Metrics:", initM);

  console.log("\n=== RUNNING OPTIMIZE GAP2 ===");
  const res = await engine.optimize("optimize_gap2", (p) => {
    console.log(`Progress: ${p.percent}% | Metrics:`, p.metrics);
  });

  console.log("\n=== FINAL RESULT ===");
  console.log("Final Metrics:", res ? res.metrics : "No result");
}

testEngine().catch(err => console.error("FATAL ERROR:", err));
