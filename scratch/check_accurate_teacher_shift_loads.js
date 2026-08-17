const fs = require('fs');

const schoolData = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/school_default_vps.json', 'utf8'));

const engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');
eval(engineCode);

const FetTimetableEngine = globalThis.FetTimetableEngine;

const engine = new FetTimetableEngine(schoolData);

// Find each class shift by checking which slots are not off
const classShift = new Map();
engine.classes.forEach(c => {
  let mCount = 0;
  let aCount = 0;
  for(let d = 0; d < 6; d++){
    for(let p = 0; p < 5; p++){
      const sm = d * 10 + p;
      const sa = d * 10 + 5 + p;
      if(!engine.offSlots.has(`${c.id}|${sm}`)) mCount++;
      if(!engine.offSlots.has(`${c.id}|${sa}`)) aCount++;
    }
  }
  classShift.set(c.id, mCount > aCount ? 0 : 1);
});

// Teacher shift loads
const teacherLoads = new Map();
engine.activities.forEach(act => {
  if(!act.gv) return;
  const shift = classShift.get(act.classId);
  const key = `${act.gv}|${shift}`;
  teacherLoads.set(key, (teacherLoads.get(key) || 0) + act.duration);
});

console.log("Teacher Shift Loads:");
teacherLoads.forEach((load, key) => {
  const [gv, shift] = key.split('|');
  const shiftName = shift === '0' ? 'Sáng' : 'Chiều';
  if(load <= 3){
    console.log(`Teacher ${gv} (${shiftName}): total ${load} periods`);
  }
});
