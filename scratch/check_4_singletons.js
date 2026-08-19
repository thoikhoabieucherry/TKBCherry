const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

console.log("=== CHECKING TD.Kiệt and T.Huy ===");
for(const tname of ['td.kiệt', 't.huy', 'tn.sương', 'a.khánh']){
  const grid = solver.teacherGrid.get(tname);
  console.log(`\nGV ${tname}:`);
  for(let d = 0; d < 6; d++){
    for(let b = 0; b < 2; b++){
      const sStart = d * 10 + b * 5;
      const acts = [];
      for(let p = 0; p < 5; p++){
        const id = grid[sStart + p];
        if(id >= 0){
          const a = solver.activities[id];
          acts.push(`T${p+1}: ${a.subject} (${a.classId}, dur=${a.duration})`);
        }
      }
      if(acts.length > 0){
        console.log(`  Thứ ${d+2} ${b===0?'Sáng':'Chiều'}: ${acts.join(', ')}`);
      }
    }
  }
}
