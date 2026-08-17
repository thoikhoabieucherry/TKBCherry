const fs = require('fs');
const path = require('path');

// 1. Load engine
const engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
eval(engineCode);

// 2. Load snapshot gap4
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default_gap7.json", 'utf8'));

async function runPass2() {
  console.log("=== RUNNING PASS 2 FROM SNAPSHOT (GAP2 = 4) ===");
  const options = {
    uiBreathingMs: 0,
    optimizeRestartBudgetMs: 45000,
    optimizeMaxRestarts: 15
  };
  
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();
  engine.pushToZero = true;

  const initM = engine.evaluateMetrics();
  console.log("Initial Metrics:", initM);

  const res = await engine.optimize("optimize_gap2", (p) => {
    console.log(`[Progress ${p.percent}%] Gap-2: ${p.metrics?.soBuoiTrong2} | Singletons: ${p.metrics?.soBuoiDay1}`);
  });

  console.log("\n=== FINAL RESULT PASS 2 ===");
  console.log(res ? res.metrics : "No result");
  
  const residual = engine.getResidualGap2Sessions ? engine.getResidualGap2Sessions() : [];
  console.log("Residual Gap-2 Sessions:", residual);
}

runPass2().catch(err => console.error("FATAL ERROR:", err));
