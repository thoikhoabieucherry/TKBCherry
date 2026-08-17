const fs = require('fs');
const path = require('path');

// 1. Load engine code
let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');

// Replace compareMetrics in engineCode for testing
const oldCompare = `      if(mode === "optimize_gap2"){
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;

        const budget = this.gap2SessionBudget || 0;
        const baseTs = this.initialMetricsSnapshot?.tsBuoiDay || 0;
        if(baseTs > 0){
          const aOver = a.tsBuoiDay > (baseTs + budget);
          const bOver = b.tsBuoiDay > (baseTs + budget);
          if(aOver !== bOver) return aOver ? 1 : -1;
        }

        if(a.soBuoiTrong2 !== b.soBuoiTrong2) return a.soBuoiTrong2 - b.soBuoiTrong2;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        return a.tsNgayDay - b.tsNgayDay;
      }`;

const newCompare = `      if(mode === "optimize_gap2"){
        if(a.soBuoiTrong2 !== b.soBuoiTrong2){
          const initSingle = this.initialMetricsSnapshot?.soBuoiDay1 ?? 999;
          const aSingleExceed = Math.max(0, a.soBuoiDay1 - initSingle);
          const bSingleExceed = Math.max(0, b.soBuoiDay1 - initSingle);
          if(aSingleExceed !== bSingleExceed) return aSingleExceed - bSingleExceed;
          return a.soBuoiTrong2 - b.soBuoiTrong2;
        }
        if(a.soBuoiDay1 !== b.soBuoiDay1) return a.soBuoiDay1 - b.soBuoiDay1;
        if(a.tsBuoiDay !== b.tsBuoiDay) return a.tsBuoiDay - b.tsBuoiDay;
        if(a.soBuoiTrong1 !== b.soBuoiTrong1) return a.soBuoiTrong1 - b.soBuoiTrong1;
        return a.tsNgayDay - b.tsNgayDay;
      }`;

engineCode = engineCode.replace(oldCompare, newCompare);
eval(engineCode);

// 2. Load school_default.json
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

async function testNewPolicy() {
  console.log("=== TESTING NEW GAP2 POLICY ON SCHOOL DEFAULT ===");
  const options = {
    uiBreathingMs: 0,
    optimizeRestartBudgetMs: 45000,
    optimizeMaxRestarts: 12
  };
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();

  const initM = engine.evaluateMetrics();
  console.log("Initial Metrics:", initM);

  const res = await engine.optimize("optimize_gap2", (p) => {
    console.log(`Progress: ${p.percent}% | Metrics:`, p.metrics);
  });

  console.log("\n=== FINAL METRICS WITH NEW POLICY ===");
  console.log(res ? res.metrics : "No result");
}

testNewPolicy().catch(err => console.error("FATAL ERROR:", err));
