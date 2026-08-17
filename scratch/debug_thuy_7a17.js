const fs = require("fs");
const path = require("path");

const ENGINE_PATH = path.resolve(__dirname, "../web/pages/tkb-fet-engine.js");
eval(fs.readFileSync(ENGINE_PATH, "utf8"));

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));

const engine = new FetTimetableEngine(data, { seed: 101 });
engine.loadExistingSchedule();

console.log("=== INSPECTING CO TN.NU ===");
const tNu = engine.teacherGrid.get("tn.nữ") || engine.teacherGrid.get("tn.nu");
console.log("Teacher tn.nu found:", !!tNu);
if(tNu){
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      const acts = [];
      for(let p = 0; p < 5; p++){
        const aId = tNu[sStart + p];
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

// Check all swap candidates between T2 Chiều (Slot 5) and T7 Chiều (Slots 55..59)
const actToanT2 = engine.activities.find(a => a.classId === "7A17" && a.mon === "Toán" && engine.actPlacement[a.id] === 5);
console.log("\nAct Toán T2 Chiều:", actToanT2?.id);

for(let p = 0; p < 5; p++){
  const targetSlot = 55 + p;
  const aId = engine.classGrid.get("7A17")[targetSlot];
  if(aId >= 0){
    const targetAct = engine.activities[aId];
    console.log(`Target Slot ${targetSlot} (T7 Chiều T${p+1}): Act #${aId} (${targetAct.mon} - ${targetAct.gv})`);
    
    // Check conflicts if we move actToanT2 -> targetSlot and targetAct -> 5
    engine.unplaceActivity(actToanT2.id);
    engine.unplaceActivity(targetAct.id);
    
    const r1 = engine.getConflictsForSlot(actToanT2, targetSlot);
    const r2 = engine.getConflictsForSlot(targetAct, 5);
    
    console.log(`  Swap possible? r1 (${actToanT2.mon} -> ${targetSlot}): ${r1.possible} (conflicts: ${r1.conflicts.length}), r2 (${targetAct.mon} -> 5): ${r2.possible} (conflicts: ${r2.conflicts.length})`);
    if(r1.possible && r1.conflicts.length === 0 && r2.possible && r2.conflicts.length === 0){
      engine.placeActivityDirect(actToanT2.id, targetSlot);
      engine.placeActivityDirect(targetAct.id, 5);
      const safe = engine.isLessonBlockSafe(actToanT2, targetAct);
      const m = engine.evaluateMetrics();
      console.log(`  => VALID SWAP! Safe: ${safe}, soBuoiDay1: ${m.soBuoiDay1}, soBuoiTrong2: ${m.soBuoiTrong2}`);
      engine.unplaceActivity(actToanT2.id);
      engine.unplaceActivity(targetAct.id);
    }
    engine.placeActivityDirect(actToanT2.id, 5);
    engine.placeActivityDirect(targetAct.id, targetSlot);
  } else {
    console.log(`Target Slot ${targetSlot} (T7 Chiều T${p+1}): EMPTY (${aId})`);
  }
}
