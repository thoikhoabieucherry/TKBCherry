const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

// Check A.CVân
const tKey = 'a.cvân';
const tGrid = solver.teacherGrid.get(tKey);

console.log("=== CHECKING A.CVân ===");
for(let d = 0; d < 6; d++){
  for(let b = 0; b < 2; b++){
    const sStart = d * 10 + b * 5;
    const acts = [];
    for(let p = 0; p < 5; p++){
      const id = tGrid[sStart + p];
      if(id >= 0){
        const a = solver.activities[id];
        acts.push(`T${p+1}: ${a.subject || a.mon} (${a.classId}, dur=${a.duration}) [id=${a.id}]`);
      }
    }
    if(acts.length > 0){
      console.log(`Thứ ${d+2} ${b===0?'Sáng':'Chiều'} (${acts.length} tiết): ${acts.join(', ')}`);
    }
  }
}
