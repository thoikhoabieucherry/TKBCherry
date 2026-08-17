const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== BFS MULTI-HOP CHAIN EXPLORER FOR SINGLETONS ===");
const m0 = engine.evaluateMetrics();
console.log("Initial Metrics:", JSON.stringify(m0));

// Let's identify the 4 initial singletons:
const singletons = [];
for (const [tKey, grid] of engine.teacherGrid.entries()) {
  const m = engine.evaluateTeacherMetrics(tKey);
  if (m.soBuoiDay1 > 0) {
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const acts = [];
        for(let p = 0; p < 5; p++){
          const aId = grid[sStart + p];
          if(aId >= 0) acts.push({ p, aId, act: engine.activities[aId], slot: sStart + p });
        }
        if(acts.length === 1){
          singletons.push({ tKey, d, b, sStart, item: acts[0] });
        }
      }
    }
  }
}

console.log(`Found ${singletons.length} singleton items:`);
singletons.forEach((s, idx) => {
  console.log(`  [#${idx+1}] Teacher "${s.tKey}" at ${["T2","T3","T4","T5","T6","T7"][s.d]} ${s.b===0?"Sáng":"Chiều"} Tiết ${s.item.p+1} (Slot ${s.item.slot}): Act #${s.item.aId} (${s.item.act.classId} - ${s.item.act.mon})`);
});
