const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101, optimizeHardCapMs: 30000 });
engine.loadExistingSchedule();

console.log("=== INITIAL EVALUATION OF EXCEL DATA ===");
const initialM = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(initialM));

// Print all teachers who have singletons
for (const [tKey, grid] of engine.teacherGrid.entries()) {
  const singletons = [];
  for (let d = 0; d < 6; d++) {
    for (let b = 0; b < 2; b++) {
      const sStart = d * 10 + b * 5;
      const acts = [];
      for (let p = 0; p < 5; p++) {
        const aId = grid[sStart + p];
        if (aId >= 0) {
          const a = engine.activities[aId];
          acts.push({ slot: sStart + p, aId, mon: a.mon, classId: a.classId });
        }
      }
      if (acts.length === 1) {
        singletons.push({ day: d, buoi: b === 0 ? "Sáng" : "Chiều", act: acts[0] });
      }
    }
  }
  if (singletons.length > 0) {
    console.log(`Teacher "${tKey}" has ${singletons.length} singleton sessions:`);
    singletons.forEach(s => {
      console.log(`  - Day ${s.day} ${s.buoi}: Slot ${s.act.slot} (${s.act.classId} - ${s.act.mon})`);
    });
  }
}

console.log("\n=== RUNNING OPTIMIZE_SINGLETONS ===");
engine.optimize("optimize_singletons", (p) => {
  console.log(`[Progress ${p.percent}%] Singletons: ${p.currentMetric} / ${p.initialMetric}`);
}).then(res => {
  console.log("\n=== OPTIMIZATION RESULT ===");
  console.log("Final Metrics:", JSON.stringify(res.metrics));
  console.log("Residual singletons:", JSON.stringify(res.residualSingletons));
  console.log("Placement Integrity OK:", engine.verifyPlacementIntegrity());
});
