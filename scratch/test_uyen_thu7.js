const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INSPECTING CO UYEN ===");
let uyenKey = "";
for (const [tKey, grid] of engine.teacherGrid.entries()) {
  if (tKey.includes("uyên") || tKey.includes("uyen")) {
    uyenKey = tKey;
    console.log(`Teacher key: "${tKey}"`);
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

// Find 6/9 HĐTN act
const hdtnActs = engine.activities.filter(a => (a.classId === "6/9" || a.classId === "6A9") && a.mon.includes("HĐTN"));
console.log("\n6/9 HĐTN acts:", hdtnActs.map(a => ({ id: a.id, mon: a.mon, gv: a.gv, slot: engine.actPlacement[a.id] })));
