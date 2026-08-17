const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== EXAMINING THAY KHUONG ===");
for (const [tKey, grid] of engine.teacherGrid.entries()) {
  if (tKey.includes("khương") || tKey.includes("khuong")) {
    console.log(`Teacher key: "${tKey}"`);
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const periods = [];
        for(let p = 0; p < 5; p++){
          const aId = grid[sStart + p];
          if(aId >= 0){
            const a = engine.activities[aId];
            periods.push(`T${p+1}: ${a.classId} - ${a.mon}`);
          }
        }
        if(periods.length > 0){
          console.log(`  Day ${d} (${["T2","T3","T4","T5","T6","T7"][d]}) ${b === 0 ? "Sáng" : "Chiều"}: ${periods.join(", ")}`);
        }
      }
    }
  }
}
