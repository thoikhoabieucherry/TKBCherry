const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
let engineCode = fs.readFileSync(ENGINE_PATH, "utf8");

// Load data
const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

// Modify Thầy Khương in data to have 5 periods on Friday morning and 1 period on Saturday afternoon
// Thầy Khương classes: 7/2, 7/5, 7/4, 7/6, 7/3, 7/7
const days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const fridayClasses = ["7/2", "7/5", "7/4", "7/6", "7/3"];

// Clear all Khuong lessons across the week
for (const cls of Object.keys(data.tkb)) {
  for (const d of days) {
    for (const b of ["sang", "chieu"]) {
      for (let ti = 0; ti < 5; ti++) {
        if (data.tkb[cls][d][b][ti] && data.tkb[cls][d][b][ti].includes("Khương")) {
          data.tkb[cls][d][b][ti] = "";
        }
      }
    }
  }
}

// Place on Friday morning
fridayClasses.forEach((cls, idx) => {
  data.tkb[cls]["thu6"]["sang"][idx] = "NT(AN) - Khương";
});
// Place on Saturday afternoon Tiết 4 (ti = 3)
data.tkb["7/7"]["thu7"]["chieu"][3] = "NT(AN) - Khương";

eval(engineCode);

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INITIAL METRICS WITH THAY KHUONG (5 + 1) ===");
const m0 = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m0));
console.log("Singletons count:", m0.soBuoiDay1);

// Test running optimize_singletons
console.log("\n=== RUNNING OPTIMIZE_SINGLETONS ===");
engine.optimize("optimize_singletons", (p) => {
  console.log(`[Progress ${p.percent}%] Singletons: ${p.currentMetric} / ${p.initialMetric}`);
}).then(res => {
  console.log("\n=== OPTIMIZATION RESULT ===");
  console.log("Final Metrics:", JSON.stringify(res.metrics));
  console.log("Placement Integrity:", engine.verifyPlacementIntegrity());

  // Print Thay Khuong schedule after
  for (const [tKey, grid] of engine.teacherGrid.entries()) {
    if (tKey.includes("khương")) {
      console.log(`\nTeacher "${tKey}" schedule after:`);
      for(let d = 0; d < 6; d++){
        for(let b = 0; b < 2; b++){
          const sStart = d * 10 + b * 5;
          const acts = [];
          for(let p = 0; p < 5; p++){
            const aId = grid[sStart + p];
            if(aId >= 0){
              const a = engine.activities[aId];
              acts.push(`T${p+1}: ${a.classId} - ${a.mon}`);
            }
          }
          if(acts.length > 0){
            console.log(`  ${["T2","T3","T4","T5","T6","T7"][d]} ${b === 0 ? "Sáng" : "Chiều"}: ${acts.join(", ")}`);
          }
        }
      }
    }
  }
});
