const fs = require('fs');
const path = require('path');

// Load engine code
let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');

// We will test enhanced solver logic directly on FetTimetableEngine
eval(engineCode);

// Load school_default.json
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

async function runGap2ToZero() {
  console.log("=== SOLVING GAP2 TO ZERO FOR SCHOOL_DEFAULT ===");
  const options = {
    uiBreathingMs: 0,
    gap2SessionBudget: 20, // Allow slight session increase as requested
    optimizeRestartBudgetMs: 90000,
    optimizeMaxRestarts: 30
  };
  
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();

  const initM = engine.evaluateMetrics();
  console.log("Initial Metrics:", initM);

  // We run optimize("optimize_gap2") with pushToZero = true
  engine.pushToZero = true;

  const res = await engine.optimize("optimize_gap2", (p) => {
    if (p.percent % 5 === 0 || p.metrics?.soBuoiTrong2 <= 5) {
      console.log(`[Progress ${p.percent}%] Gap-2: ${p.metrics?.soBuoiTrong2} | Singletons: ${p.metrics?.soBuoiDay1} | Sessions: ${p.metrics?.tsBuoiDay}`);
    }
  });

  console.log("\n=== FINAL RESULT ===");
  console.log(res ? res.metrics : "No result");
}

runGap2ToZero().catch(err => console.error("FATAL ERROR:", err));
