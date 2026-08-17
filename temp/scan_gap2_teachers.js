const fs = require('fs');

const engineCode = fs.readFileSync("C:/Users/Love/Documents/Codex/TKBCherry/web/tkb-fet-engine.js", 'utf8');
const dataJson = JSON.parse(fs.readFileSync("C:/Users/Love/Documents/Codex/temp/school_default.json", 'utf8'));

eval(engineCode);

const engine = new FetTimetableEngine(dataJson, { gap2SessionBudget: 20 });
engine.init();
engine.loadExistingSchedule();

console.log("=== SCANNING ALL TEACHERS WITH GAP2 > 0 IN CURRENT TKB ===");
const days = ["thu2", "thu3", "thu4", "thu5", "thu6", "thu7"];
const sessions = ["sang", "chieu"];

for(const [tKey, grid] of engine.teacherGrid.entries()){
  if(!tKey || !engine.isScoredTeacher(tKey)) continue;
  const tm = engine.evaluateTeacherMetrics(tKey);
  if(tm.soBuoiTrong2 > 0){
    console.log(`\n--- Teacher: ${tKey} (soBuoiTrong2: ${tm.soBuoiTrong2}, soBuoiTrong1: ${tm.soBuoiTrong1}, tsBuoiDay: ${tm.tsBuoiDay}) ---`);
    for(let d = 0; d < 6; d++){
      for(let b = 0; b < 2; b++){
        const sStart = d * 10 + b * 5;
        const acts = [];
        for(let p = 0; p < 5; p++){
          const aId = grid[sStart + p];
          if(aId >= 0){
            const a = engine.activities[aId];
            acts.push(`P${p+1}: ${a.classId} (${a.subject})`);
          }else if(aId === -3){
            acts.push(`P${p+1}: FIXED`);
          }else{
            acts.push(`P${p+1}: _`);
          }
        }
        console.log(`  ${days[d]} ${sessions[b]}: [ ${acts.join(" | ")} ]`);
      }
    }
  }
}
