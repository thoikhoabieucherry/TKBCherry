const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "test_state_0917.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== EXAMINING CO HIEN SCHEDULE IN ENGINE ===");
// Find Cô Hiền key
for (const [tKey, grid] of engine.teacherGrid.entries()) {
  if (tKey.includes("hiền") || tKey.includes("hien")) {
    console.log(`Found teacher: "${tKey}"`);
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

// Find Class 6/10 schedule
for (const [cKey, grid] of engine.classGrid.entries()) {
  if (cKey === "6/10" || cKey === "6A10" || cKey.includes("6/10") || cKey.includes("6.10")) {
    console.log(`\nFound class: "${cKey}"`);
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const periods = [];
        for(let p = 0; p < 5; p++){
          const aId = grid[sStart + p];
          if(aId >= 0){
            const a = engine.activities[aId];
            periods.push(`T${p+1}: ${a.mon} (${a.gv})`);
          } else {
            periods.push(`T${p+1}: [TRỐNG]`);
          }
        }
        console.log(`  Day ${d} (${["T2","T3","T4","T5","T6","T7"][d]}) ${b === 0 ? "Sáng" : "Chiều"}: ${periods.join(", ")}`);
      }
    }
  }
}
