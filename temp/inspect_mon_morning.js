const fs = require('fs');

let engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

console.log("=== INSPECTING CLASS L069 & L013 ON THU 2 SANG ===");
const cid69 = "L069";
const cid13 = "L013";

const cg69 = engine.classGrid.get(cid69);
const cg13 = engine.classGrid.get(cid13);

console.log("Class L069 Thu 2 Sang periods:");
for(let p = 0; p < 5; p++){
  const actId = cg69[p];
  if(actId >= 0){
    const a = engine.activities[actId];
    console.log(`  P${p+1}: ${a.subject} (GV: ${a.gv})`);
  } else if(actId === -3){
    console.log(`  P${p+1}: FIXED`);
  } else {
    console.log(`  P${p+1}: _ (${actId})`);
  }
}

console.log("\nClass L013 Thu 2 Sang periods:");
for(let p = 0; p < 5; p++){
  const actId = cg13[p];
  if(actId >= 0){
    const a = engine.activities[actId];
    console.log(`  P${p+1}: ${a.subject} (GV: ${a.gv})`);
  } else if(actId === -3){
    console.log(`  P${p+1}: FIXED`);
  } else {
    console.log(`  P${p+1}: _ (${actId})`);
  }
}
