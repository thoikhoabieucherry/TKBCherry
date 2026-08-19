const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('./test_state_0917.json', 'utf8'));
const engineCode = fs.readFileSync('../web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const solver = new globalThis.FetTimetableEngine(schoolData);
solver.loadExistingSchedule();

// Trace TD.Kiệt
const tKey = 'td.kiệt';
const tGrid = solver.teacherGrid.get(tKey);

console.log("=== Tracing TD.Kiệt ===");
// Singleton 1: Thu 2 Sang T4 (Slot 3, Class 6A16)
const act1 = solver.activities[tGrid[3]];
console.log("Singleton 1:", act1.id, act1.subject, act1.classId, "at Slot 3");

// Candidate sessions of TD.Kiệt in Sang:
// Thu 3 Sang (Slots 10-14, taught: 10, 11)
// Thu 4 Sang (Slots 20-24, taught: 20, 21)
// Thu 6 Sang (Slots 40-44, taught: 40, 41, 42, 44)
const cGrid16 = solver.classGrid.get('6A16');
for(const s2 of [10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 40, 41, 42, 43, 44]){
  const occC = cGrid16[s2];
  const occT = tGrid[s2];
  const occAct = occC >= 0 ? solver.activities[occC] : null;
  console.log(`Slot ${s2}: Class 6A16 has ${occAct ? (occAct.subject + ' - ' + occAct.teacherId) : (occC===-3?'OFF':'EMPTY')} | TD.Kiệt has ${occT>=0?'OCC':'FREE'}`);
  if(occAct && occAct.teacherId !== tKey && occT < 0){
    const tGridOcc = solver.teacherGrid.get(occAct.teacherId);
    console.log(`   -> Can ${occAct.teacherId} move to Slot 3 (Class 6A16)? Teacher free at 3: ${tGridOcc[3] < 0}`);
  }
}
