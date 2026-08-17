const fs = require('fs');
const path = require('path');

// 1. Load engine
const enginePath = "C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js";
const engineCode = fs.readFileSync(enginePath, 'utf8');
eval(engineCode);

// 2. Load school_default.json
const dataPath = "C:/Users/Love/Documents/Codex/temp/school_default.json";
const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

async function testDefault() {
  console.log("=== TESTING SCHOOL DEFAULT ===");
  const options = {
    uiBreathingMs: 0,
    gap2SessionBudget: 0,
    optimizeRestartBudgetMs: 30000
  };
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();

  const initM = engine.evaluateMetrics();
  console.log("Initial Metrics for school_default:", initM);

  console.log("\nResidual 2-gap sessions before:", engine.getResidualGap2Sessions ? engine.getResidualGap2Sessions() : "N/A");

  console.log("\n=== RUNNING OPTIMIZE GAP2 ===");
  const res = await engine.optimize("optimize_gap2", (p) => {
    console.log(`Progress: ${p.percent}% | Metrics:`, p.metrics);
  });

  console.log("\n=== FINAL RESULT ===");
  console.log("Final Metrics:", res ? res.metrics : "No result");
}

testDefault().catch(err => console.error("FATAL ERROR:", err));
