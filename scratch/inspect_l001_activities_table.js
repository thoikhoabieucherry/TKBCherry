const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('scratch/test_no_decomp.js', 'utf8');
eval(engineCode.split('const schoolData')[0]);

const FetTimetableEngine = globalThis.FetTimetableEngine;
const engine = new FetTimetableEngine(schoolData);
engine.solve();

console.log("Class L001 schedule after solve:");
const cGrid = engine.classGrid.get('L001');
for(let d = 0; d < 6; d++){
  const dayName = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'][d];
  const morning = [];
  for(let p = 0; p < 5; p++){
    const actId = cGrid[d * 10 + p];
    const a = actId >= 0 ? engine.activities[actId] : null;
    morning.push(a ? `${a.mon}(${a.duration})` : (actId === -3 ? 'FIXED' : (actId === -2 ? 'OFF' : '--')));
  }
  const afternoon = [];
  for(let p = 0; p < 5; p++){
    const actId = cGrid[d * 10 + 5 + p];
    const a = actId >= 0 ? engine.activities[actId] : null;
    afternoon.push(a ? `${a.mon}(${a.duration})` : (actId === -3 ? 'FIXED' : (actId === -2 ? 'OFF' : '--')));
  }
  console.log(`${dayName} Sáng:  [${morning.join(', ')}]`);
  console.log(`${dayName} Chiều: [${afternoon.join(', ')}]`);
}
