const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INSPECTING TEACHERS WITH SINGLETONS ===");
for (const [tKey, grid] of engine.teacherGrid.entries()) {
  const m = engine.evaluateTeacherMetrics(tKey);
  if (m.soBuoiDay1 > 0) {
    console.log(`Teacher "${tKey}": soBuoiDay1 = ${m.soBuoiDay1}, total sessions = ${m.tsBuoiDay}`);
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
          console.log(`  ${["T2","T3","T4","T5","T6","T7"][d]} ${b === 0 ? "Sáng" : "Chiều"}: (${acts.length} tiết) ${acts.join(", ")}`);
        }
      }
    }
  }
}

console.log("\n=== INSPECTING TEACHERS WITH 2-PERIOD GAPS (soBuoiTrong2 > 0) ===");
for (const [tKey, grid] of engine.teacherGrid.entries()) {
  const m = engine.evaluateTeacherMetrics(tKey);
  if (m.soBuoiTrong2 > 0) {
    console.log(`Teacher "${tKey}": soBuoiTrong2 = ${m.soBuoiTrong2}`);
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
