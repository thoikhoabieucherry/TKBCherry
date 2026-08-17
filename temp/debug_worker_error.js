const fs = require('fs');

// Load engine code exactly as written in TKBCherry/web/tkb-fet-engine.js
let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');

try {
  eval(engineCode);
  console.log("Syntax & Eval Check: PASSED!");
} catch(err) {
  console.error("SYNTAX / EVAL ERROR IN ENGINE:", err);
  process.exit(1);
}

const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

async function testWorkerExecution() {
  console.log("=== SIMULATING BACKGROUND WORKER EXECUTION ===");
  const options = {
    uiBreathingMs: 0,
    optimizeRestartBudgetMs: 30000,
    gap2SessionBudget: 20
  };
  
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();

  console.log("Initial Metrics:", engine.evaluateMetrics());

  try {
    const res = await engine.optimize("optimize_gap2", (p) => {
      console.log(`[Progress ${p.percent}%] Metrics:`, p.metrics);
    });
    console.log("\n=== SUCCESSFUL COMPLETION ===");
    console.log(res ? res.metrics : "No result");
  } catch(err) {
    console.error("RUNTIME ERROR IN OPTIMIZE_GAP2:", err.stack || err);
  }
}

testWorkerExecution();
