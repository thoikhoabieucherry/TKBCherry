const fs = require('fs');

// Load engine
const engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

console.log("=== INSPECTING TEACHER T.CUONG IN SCHOOL_DEFAULT ===");
const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

const tKey = "t.cường"; // or find key for Chau Quoc Cuong
let foundKey = null;
for(const k of engine.teacherGrid.keys()){
  if(k.includes("cường") || k.includes("cuong")){
    foundKey = k;
    break;
  }
}
console.log("Found teacher key:", foundKey);
if(foundKey){
  const tm = engine.evaluateTeacherMetrics(foundKey);
  console.log("Teacher metrics for", foundKey, ":", tm);
}
