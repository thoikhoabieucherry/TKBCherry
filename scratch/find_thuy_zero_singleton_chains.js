const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== EXPLORING CHAINS TO ELIMINATE THAY HUY SINGLETON ===");
const actT7 = engine.activities.find(a => a.classId === "7A17" && a.mon === "Toán" && engine.actPlacement[a.id] === 55);
const actT2 = engine.activities.find(a => a.classId === "7A17" && a.mon === "Toán" && engine.actPlacement[a.id] === 5);

console.log("Act T7 Chiều T1:", actT7?.id);
console.log("Act T2 Chiều T1:", actT2?.id);

// Target 1: Can we move actT7 (from Slot 55) to any slot in 7A17 on T2 Chiều, T3 Chiều, T4 Chiều, T5 Chiều, T6 Chiều?
// Or can we do a 3-way cycle involving 7A17?
console.log("\n--- Testing 3-way cycles for actT7 (Slot 55) ---");
const c7A17 = engine.classGrid.get("7A17");

let foundChains = 0;

for(let s2 = 0; s2 < 60; s2++){
  if(s2 === 55 || s2 % 10 < 5) continue; // Only afternoon slots for 7A17
  const aId2 = c7A17[s2];
  if(aId2 < 0) continue;
  const act2 = engine.activities[aId2];
  if(!act2 || act2.isFixed || act2.duration !== 1) continue;

  for(let s3 = 0; s3 < 60; s3++){
    if(s3 === 55 || s3 === s2) continue;
    // s3 could be in act2's class or any class
    const aId3 = engine.classGrid.get(act2.classId)[s3];
    if(aId3 < 0) continue;
    const act3 = engine.activities[aId3];
    if(!act3 || act3.isFixed || act3.duration !== 1) continue;

    // Test cycle: actT7 -> s2, act2 -> s3, act3 -> 55 (if act3 class is 7A17) OR act2 -> 55 directly
  }
}

// Let's test 2-way and 3-way relocations across the entire 7A17 schedule
for(let d = 0; d < 6; d++){
  const b = 1; // Chiều
  const sStart = d * 10 + b * 5;
  for(let p = 0; p < 5; p++){
    const s2 = sStart + p;
    if(s2 === 55) continue;
    const aId2 = c7A17[s2];
    if(aId2 < 0) continue;
    const act2 = engine.activities[aId2];
    if(!act2 || act2.isFixed) continue;

    // Try 2-way swap between actT7 (Slot 55) and act2 (Slot s2)
    engine.unplaceActivity(actT7.id);
    engine.unplaceActivity(act2.id);

    const r1 = engine.getConflictsForSlot(actT7, s2);
    const r2 = engine.getConflictsForSlot(act2, 55);

    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
      engine.placeActivityDirect(actT7.id, s2);
      engine.placeActivityDirect(act2.id, 55);
      if(engine.isLessonBlockSafe(actT7, act2)){
        const m = engine.evaluateMetrics();
        console.log(`[Valid 2-way Swap] actT7 -> Slot ${s2} (${act2.mon} - ${act2.gv}), act2 -> Slot 55:`);
        console.log(`  Metrics: soBuoiDay1 = ${m.soBuoiDay1}, soBuoiTrong2 = ${m.soBuoiTrong2}, tsBuoiDay = ${m.tsBuoiDay}`);
        foundChains++;
      }
      engine.unplaceActivity(actT7.id);
      engine.unplaceActivity(act2.id);
    }
    engine.placeActivityDirect(actT7.id, 55);
    engine.placeActivityDirect(act2.id, s2);
  }
}

console.log(`Total valid 2-way swaps found for actT7: ${foundChains}`);
