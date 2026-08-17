const fs = require('fs');

// Load freshly refactored engine from TKBCherry/web
let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
eval(engineCode);

// Load school_default.json
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

async function testFullRefactored() {
  console.log("=== TESTING FULL REFACTORED OPTIMIZER ON SCHOOL_DEFAULT ===");
  const options = {
    uiBreathingMs: 0,
    optimizeRestartBudgetMs: 60000,
    optimizeMaxRestarts: 20
  };
  
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();
  engine.pushToZero = true;

  console.log("Initial Metrics:", engine.evaluateMetrics());

  const res = await engine.optimize("optimize_gap2", (p) => {
    if (p.percent % 10 === 0 || p.metrics?.soBuoiTrong2 <= 5) {
      console.log(`[Progress ${p.percent}%] Gap-2: ${p.metrics?.soBuoiTrong2} | Singletons: ${p.metrics?.soBuoiDay1} | Sessions: ${p.metrics?.tsBuoiDay} | Gap-1: ${p.metrics?.soBuoiTrong1}`);
    }
  });

  console.log("\n=== FINAL RESULT ===");
  console.log(res ? res.metrics : "No result");
}

testFullRefactored().catch(err => console.error("FATAL ERROR:", err));
