const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

async function testFullExcelRuleConvergence() {
  console.log("=== RUNNING FULL 4-TIER LOCAL SEARCH (EXCEL RULES) ON DEFAULT ===");
  const options = {
    uiBreathingMs: 0,
    optimizeRestartBudgetMs: 40000,
    gap2SessionBudget: 30
  };
  
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();

  console.log("Initial Metrics (Base):", engine.evaluateMetrics());

  const res = await engine.optimize("optimize_gap2", (p) => {
    if (p.percent % 10 === 0 || p.metrics?.soBuoiTrong2 <= 3) {
      console.log(`[Prog ${p.percent}%] Gap-2: ${p.metrics?.soBuoiTrong2} | Singletons: ${p.metrics?.soBuoiDay1} | Sessions: ${p.metrics?.tsBuoiDay} | Gap-1: ${p.metrics?.soBuoiTrong1}`);
    }
  });

  console.log("\n=== OPTIMIZATION SUMMARY (EXCEL RULE REPLICATION) ===");
  console.log("Initial 2-Gaps:", 22);
  console.log("Final 2-Gaps:", res?.metrics?.soBuoiTrong2);
  console.log("Final 1-Gaps:", res?.metrics?.soBuoiTrong1);
  console.log("Final Sessions:", res?.metrics?.tsBuoiDay);
}

testFullExcelRuleConvergence();
