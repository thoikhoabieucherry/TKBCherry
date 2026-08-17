const fs = require('fs');
const path = require('path');

// 1. Load engine
const engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
eval(engineCode);

// 2. Load school_default.json
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

async function inspectResidual7() {
  const options = {
    uiBreathingMs: 0,
    optimizeRestartBudgetMs: 30000,
    optimizeMaxRestarts: 10
  };
  
  const engine = new FetTimetableEngine(dataJson, options);
  engine.init();
  engine.loadExistingSchedule();
  engine.pushToZero = true;

  const res = await engine.optimize("optimize_gap2");
  console.log("Final Metrics:", res ? res.metrics : "No result");

  // Get residual gap 2
  const residual = engine.getResidualGap2Sessions ? engine.getResidualGap2Sessions() : [];
  console.log("\n=== RESIDUAL GAP-2 SESSIONS ===");
  console.log(JSON.stringify(residual, null, 2));

  // Save intermediate state TKB to temp
  const outData = {
    ...dataJson,
    tkb: engine.getSnapshotTKB()
  };
  fs.writeFileSync("C:/Users/Love/Documents/Codex/temp/school_default_gap7.json", JSON.stringify(outData, null, 2), "utf8");
  console.log("\nSaved snapshot to school_default_gap7.json");
}

inspectResidual7().catch(err => console.error("FATAL ERROR:", err));
