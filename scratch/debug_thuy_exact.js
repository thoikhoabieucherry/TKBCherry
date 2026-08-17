const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INSPECTING THAY HUY IN ENGINE ===");
const tKey = "t.huy";
const tGrid = engine.teacherGrid.get(tKey);
console.log("Teacher grid found:", !!tGrid);

// Find all activities of t.huy
const acts = engine.activities.filter(a => a.gv.toLowerCase() === "t.huy");
console.log(`Found ${acts.length} activities for Thầy Huy:`);
acts.forEach(a => {
  const slot = engine.actPlacement[a.id];
  const d = Math.floor(slot / 10);
  const b = Math.floor((slot % 10) / 5);
  const p = slot % 5;
  console.log(`  Act #${a.id}: Class ${a.classId}, Mon: ${a.mon}, isFixed: ${a.isFixed}, duration: ${a.duration} => Slot ${slot} (${["T2","T3","T4","T5","T6","T7"][d]} ${b===0?"Sáng":"Chiều"} Tiết ${p+1})`);
});

// Let's check 7A17 class grid
const c7A17 = engine.classGrid.get("7A17");
console.log("\n=== 7A17 CLASS GRID ===");
for(let d = 0; d < 6; d++){
  for(let b = 0; b < 2; b++){
    const sStart = d * 10 + b * 5;
    const row = [];
    for(let p = 0; p < 5; p++){
      const aId = c7A17[sStart + p];
      if(aId >= 0){
        const a = engine.activities[aId];
        row.push(`T${p+1}: ${a.mon} (${a.gv})`);
      } else {
        row.push(`T${p+1}: [${aId}]`);
      }
    }
    console.log(`  ${["T2","T3","T4","T5","T6","T7"][d]} ${b===0?"Sáng":"Chiều"}: ${row.join(", ")}`);
  }
}
